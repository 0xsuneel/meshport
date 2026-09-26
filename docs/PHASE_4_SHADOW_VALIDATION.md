# Phase 4 — Shadow Validation & Event Integration

Status: **complete, inert**. BlockchainIndexer observes and reports. It is not
authoritative, consumes no refresh path, and no legacy worker was touched.

---

## 1. Files created

| File | Lines | Purpose |
|---|---|---|
| `supabase/migrations/20260807130000_shadow_validation_and_retention.sql` | 271 | `indexer_config`, `indexer_shadow_reports`, `prune_chain_events()`, `prune_shadow_reports()`, RLS, cron |
| `supabase/functions/blockchain-indexer/compare.ts` | — | Pure comparison: `compareDeposits`, `compareClaims`, `normalizeTxHash` |
| `supabase/functions/blockchain-indexer/monitor.ts` | — | `runCompare` (persists a report), `runMetrics` (live health read) |
| `src/blockchain/shadowEventMap.ts` | 68 | Pure `mapChainEventRow` + `latencyStats`. No client dependency — testable without credentials |
| `src/blockchain/shadowEventBus.ts` | 123 | Realtime subscription to `chain_events`. Observation only |
| `scripts/verify-phase4.ts` | 156 | Comparison-logic assertions (26) |
| `scripts/verify-phase4-bus.ts` | 111 | Mapping + latency + delivery-contract assertions (16) |

## 2. Files modified

| File | Change |
|---|---|
| `supabase/functions/blockchain-indexer/index.ts` | Added `compare` and `metrics` modes. Scan path unchanged |
| `src/components/layout/AppLayout.tsx` | +2 blocks: import, and a `walletAddress`-scoped `shadowEventBus.start/stop` effect |

`AppLayout.tsx` is the only production file touched. The effect calls nothing but
the bus; it does not invalidate a query, write a store, or trigger a fetch.

---

## 3. Shadow mode architecture

```
Arc / EVM chains
      │
      ├──────────────── LEGACY (authoritative, untouched) ──────────────┐
      │   deposit-scan-all ─┐                                           │
      │   claim-worker ─────┼──► activity / claims ──► Realtime ──► UI  │
      │   claim-recovery ───┘                          refreshes        │
      │                                                                 │
      └──────────────── SHADOW (observational) ─────────────────────────┘
          BlockchainIndexer
                │
                ├──► chain_events (pending → confirmed at depth)
                │         │
                │         └──► Realtime ──► shadowEventBus ──► console + latency
                │                              (dead end: no refresh)
                └──► compare mode ──► indexer_shadow_reports
```

Two independent isolation guarantees, not one:

1. **Nothing subscribes to the bus.** `shadowEventBus` has no consumers — a
   `grep` for it outside `src/blockchain/` returns only the AppLayout mount.
2. **`indexer_config.shadow_mode.authoritative = false`.** Cutover is an
   `UPDATE`, not a deploy, so the flip is reversible in seconds.

## 4. Event comparison report

`compare.ts` classifies every deposit/claim into three buckets:

- `matched` — both systems saw it
- **`worker_only`** — legacy saw it, indexer did not. **This is the cutover gate.**
- `indexer_only` — indexer saw it first, or legacy missed it. Needs eyeballing, not alarm

`recall_pct = matched / (matched + worker_only)`, and is **NULL when nothing was
compared** — deliberately distinct from `0%`, so an idle window cannot be
averaged into the trend as if it were a total failure.

Verified in `scripts/verify-phase4.ts` (26/26). The assertions that matter:

| Assertion | Why it exists |
|---|---|
| `recv_`-prefixed activity hashes normalize before matching | `claim-recovery-scan` writes synthetic `recv_<hash>` ids. Naive comparison would report **100% of external deposits as `worker_only`** — a fabricated failure |
| Case + `0x` normalization | Checksummed vs lowercase hashes are the same event |
| Empty window → `recall = NULL` | No false 0% |
| Nothing missed → `recall = 100`, `worker_only = 0` | The gate is reachable |

**Live results: not yet available.** These are unit-verified rules, not
measurements. Real numbers require the migration deployed and testnet traffic
observed — see §10.

## 5. Synchronization metrics

`GET ?mode=metrics` returns, per chain: `last_indexed_block`,
`latest_observed_block`, **lag** (the derived number alerting reads),
`sync_state`, `consecutive_failures`, `reorg_count`, `last_reorg_at`.

Client-side, `shadowEventBus.stats()` reports `count`, `byType`, and publication
latency (`min`/`median`/`p95`/`max`) measured as `now − created_at` at delivery.

Two deliberate choices, both asserted:

- A missing `created_at` yields **`−1`, not `0`** — a `0ms` latency would read as
  a perfect instant delivery, which is the most misleading possible value.
- An empty or all-invalid sample yields **`null`, not `0`** — same reasoning.

## 6. Cursor metrics

Covered by Phase 3's `cursorMath` suite (26/26, still green). Phase 4 exposes
them: `reorg_count`, `last_reorg_at`, `consecutive_failures`, `sync_state`.

The load-bearing one is `safeAdvance` — a **gap** in chunk results stops the
cursor at the last *contiguous* success, so a mid-range failure is retried
rather than skipped. A skipped range logs nothing and loses deposits silently;
that is the exact failure this asserts against, including the out-of-order
completion case.

## 7. Reorg validation

| Rule | Behavior |
|---|---|
| Detection | Parent-hash mismatch, case-insensitive |
| First pass (`null` hash) | **Not** a reorg |
| Unavailable parent hash | **Not** asserted as a reorg — unknown ≠ reorged |
| Rollback | `depth + 1` below cursor, clamped at genesis, strictly below current |
| Retraction | Events marked `reorged`, never deleted — auditable |
| Duplicate prevention | DB partial unique index on `(event_type, chain_id, tx_hash, block_number)` — enforced in Postgres, not application code, so a crashed or overlapping pass cannot double-publish |

Validated against synthetic inputs. **Not yet observed on a real reorg** — Arc
testnet's fast finality means one may not occur during the validation window.
Stated rather than implied.

## 8. Event accuracy report

Unit-level: 68/68 across four suites (`phase25` 18, `phase3` 26, `phase4` 26,
`phase4-bus` 16). Typecheck clean, production build passes.

Accuracy **under real traffic is unmeasured** and is the entire remaining
purpose of this phase. The gate for Phase 5: `worker_only = 0` sustained across
a meaningful window with non-trivial `matched` volume.

## 9. Remaining differences between old and new

| Concern | Legacy | Indexer |
|---|---|---|
| Reorg handling | None — scans to `latest`, advances past it, never retracts | Detect, roll back, mark `reorged` |
| Cursor | `deposit_scan_cursor`, keyed by detection source, Arc-only, no chain column | `chain_cursors`, per-chain, with hash + depth + health |
| Confirmation | Implicit | Explicit `pending → confirmed` at per-chain depth |
| Retention | Unbounded | Configurable per status |
| Scope | Arc only | Multi-chain capable |
| **Coverage parity** | **Full** | **Unproven** |
| Claim orchestration | `claim-worker` (stateful: row locking, attempt budgets, attestation polling) | Not attempted — see §21 of the proposal |

The last two are why cutover is gated. The indexer is structurally better and
functionally unproven; those are not in tension.

## 10. Risks before production cutover

1. **Coverage parity is unmeasured.** Highest risk. A missed native-USDC transfer
   is an invisible lost deposit. Mitigation: `worker_only = 0` sustained, on real
   traffic, before any flip.
2. **Native-USDC detection is the weak path.** Arc's USDC is the native gas
   currency; plain sends emit no log, so `eth_getLogs` is structurally blind and
   full-block scanning is required. This is where a gap would hide.
3. **Reorg logic is synthetic-only.** Fast finality may mean no real reorg during
   validation. Do not read absence of reorgs as validated reorg handling.
4. **`compare` reads two schemas.** A change to `activity`/`claims` shape would
   silently skew comparison. The `recv_` case already proved how easily this
   produces a false verdict.
5. **Added load during shadow.** Indexer RPC + one extra Realtime channel per
   tab run *on top of* legacy. Temporary and intended; Phase 5's polling removal
   is what pays it back. `sync_state = 'paused'` takes a chain out without a
   deploy.
6. **Retention runs against a live DB.** Batched deletes (5k default) to avoid
   long-lived locks.

---

## Deploy

```bash
supabase db push
supabase functions deploy blockchain-indexer
```

Then, to gather live numbers:

```bash
curl -X POST "$URL/functions/v1/blockchain-indexer?mode=compare&windowMinutes=60" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY"
curl "$URL/functions/v1/blockchain-indexer?mode=metrics" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY"
```

`indexer_shadow_reports` accumulates the trend. Read `worker_only` first.

## Stop condition — honored

Nothing removed, nothing disabled, no polling touched, no compatibility layer
deleted. All 8 pre-existing cron schedules verified intact; the only
`cron.unschedule` calls in this migration target Phase 4's own jobs as an
idempotent re-run guard.

Awaiting approval before cutover.
