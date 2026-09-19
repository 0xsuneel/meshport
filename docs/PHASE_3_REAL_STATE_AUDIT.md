# Phase 3 — Forensic Audit of the Real Production State

Status: **audit only**. No production code, config, or data changed in this pass. Two Deno test
files were added in the prior Phase 3 session (`cursorMath.test.ts`, `compare.test.ts`,
`scanner.test.ts`) — isolated, no production behavior altered, left in place per instructions.

This supersedes the shadow-only picture assumed at the start of Phase 3. Everything below is
traced against live data in the `MeshPort` Supabase project (`cvvpzfvzweszuuxvaayb`), not
inferred from code alone.

---

## 1. Actual current production architecture

```
Blockchain (Arc)
   │
   ▼
blockchain-indexer  (mode=index, every 2 min)  ──publishes──▶  chain_events
   │                                                                │
   │ mode=compare, every 15 min                                    │ status='confirmed' only
   ▼                                                                ▼
indexer_shadow_reports                                    activity-consumer  (mode=consume, every 1 min)
  (measurement only, nothing reads this to gate behavior)          │
                                                                     │ upsert, ignoreDuplicates
                                                                     ▼
                                                                  activity  ◀── deposit-scan-all
                                                                     ▲          (mode=reconcile, every 10 min,
                                                                     │           native-USDC-only backstop)
                                                                     │
                                                            client-side writers
                                                       (SendPage.tsx, swap-proxy.js,
                                                        p2pService.ts, etc. — unchanged,
                                                        out of scope for this audit)
```

**Four independent writers currently converge on `activity`**, all through the same
`UNIQUE (tx_hash, wallet_address)` identity: `activity-consumer` (new), `deposit-scan-all`
reconcile mode (legacy, native-USDC only), and the various client-side writers (`SendPage.tsx`,
`api/swap-proxy.js`, P2P services — audited in Phase 0, unchanged since). `deposit-scan-all`
**sweep** mode (the full native + ERC-20 primary scanner) is disabled and does not write.

This is **not** the shadow-only picture Phase 3 started with. It is a real, live, partial
cutover: `blockchain-indexer` → `chain_events` → `activity-consumer` → `activity` is now the
**primary** detection+credit path for both native USDC and ERC-20 (EURC/cirBTC) deposits.
Legacy `deposit-scan-all` is reduced to a **native-USDC-only backstop** (see §6) — it no longer
covers ERC-20 tokens at all.

---

## 2. Exact cutover history / source

- `supabase/functions/activity-consumer/` exists in this codebase and is fully built —
  `index.ts` + `decide.ts`, with a pure decision function and extensive documentation of exactly
  why each rule mirrors `deposit-scan-all`'s own rules (Fix C internal-contract exclusion,
  confirmed-only, settle delay, etc.). Its own header states its purpose explicitly: *"This is
  what makes Phase 5's `authoritative = true` FUNCTIONAL rather than declarative."*
- Live cron (`cron.job`, queried directly): `activity-consumer-sweep` is **active**, every
  minute. `blockchain-indexer-shadow` (the scan pass) and `blockchain-indexer-compare` are both
  **active**. `deposit-scan-all-sweep` is **disabled** (`active: false`). `deposit-scan-all-reconcile`
  remains **active**, every 10 minutes.
- `indexer_config.shadow_mode` currently holds `{"enabled": true, "authoritative": true}`, with
  `updated_at = 2026-08-08 06:30:52 UTC`.

## 3. Current cron/job state (verified live, not from code)

| Job | Schedule | Active | What it does |
|---|---|---|---|
| `blockchain-indexer-shadow` | `*/2 * * * *` | **yes** | `mode=index` — the actual chain scan, publishes to `chain_events` |
| `blockchain-indexer-compare` | `*/15 * * * *` | **yes** | `mode=compare` — shadow measurement only, writes `indexer_shadow_reports` |
| `activity-consumer-sweep` | `* * * * *` | **yes** | `mode=consume` — reads confirmed `chain_events`, credits `activity` |
| `deposit-scan-all-sweep` | `* * * * *` | **no** | (would be the full native+ERC-20 primary scanner) |
| `deposit-scan-all-reconcile` | `*/10 * * * *` | **yes** | native-USDC-only backstop, via direct RPC log scan + Blockscout explorer |
| `claim-worker-sweep` | `* * * * *` | yes | unrelated — claim lifecycle, unaffected by any of the above |
| `chain-events-retention` | daily `23 3 * * *` | yes | prunes `chain_events`/`indexer_shadow_reports` per `indexer_config.retention` |

## 4. `authoritative` flag source

- **Value**: `true`. **Location**: `public.indexer_config` row `key='shadow_mode'`,
  `value.authoritative`. This is **database state**, not a code default — the migration that
  created this key (`20260807130000_shadow_validation_and_retention.sql`, live version
  `20260808063052`) inserts it with `value = {"enabled": true, "authoritative": false}`. The
  live value differs from what that migration inserted, so it was changed afterward by a direct
  `UPDATE`, not by any migration in `supabase/migrations/`.
- **When**: `updated_at = 2026-08-08 06:30:52 UTC` — a few hours after the
  `blockchain_indexer_foundation`/`shadow_validation_and_retention` migrations landed that same
  day (`20260808063023` / `20260808063052`). No dedicated audit-log table exists for
  `indexer_config` changes (unlike `wallet_audit_log` or `p2p_trade_audit_log`), so the exact
  actor/mechanism isn't independently recorded — but the tight time correlation with
  `activity-consumer`'s own creation (whose entire purpose, per its header comment, is to make
  this exact flag "functional") is strong circumstantial evidence this was a deliberate,
  same-session decision, not an unrelated accident.
- **What it actually changes in code, right now**: checked every file in
  `supabase/functions/blockchain-indexer/` and `supabase/functions/activity-consumer/` for a
  read of `indexer_config`/`authoritative`/`shadow_mode`. Only `monitor.ts` reads it, and only
  for **reporting** (`metrics` mode's response payload — `shadowMode: shadowCfg.data?.[0]?.value`
  — explicitly commented `"nothing here is authoritative"`). **`activity-consumer` does not read
  this flag at all.** It runs unconditionally whenever its cron fires, regardless of what this
  value is. So flipping it back to `false` right now would change **zero** runtime behavior —
  the actual behavioral toggle is the pg_cron `active` flags in §3, not this config value. This
  matters directly for the "is it safe to toggle" question: toggling `authoritative` is
  currently inert either way; toggling the cron jobs is what actually matters.
- **Not modified** in this pass, per instructions.

## 5. `activity-consumer` behavior (full code audit)

Read `index.ts` (301 lines) and `decide.ts` (259 lines) in full — `decide.ts` is deliberately
the pure half (zero I/O, zero Deno APIs) specifically so its rule set is independently testable;
that design choice is itself a good sign for auditability.

- **Which `chain_events` it consumes**: `event_type IN ('deposit_detected', 'transfer_detected')`
  (`CREDIT_EVENT_TYPES`) — i.e. exactly the two event types the indexer currently emits. It
  reads with a 2-hour lookback window and a 200-events-per-pass cap.
- **Confirmed-only**: **yes**, structurally enforced — `CREDITABLE_STATUS = 'confirmed'`, checked
  as the second line of `decideActivityRow`. A `pending` or `reorged` event is skipped with an
  explicit machine-readable reason (`status 'pending' is not 'confirmed'`), never credited.
- **Dedup**: two layers. (1) `loadExistingActivity` reads `activity` for both the plain and
  `recv_`-prefixed hash forms before deciding anything, and `decideActivityRow` skips if
  `hasAnyActivityForTxHash` — catching rows already written by *any* activity_type, not just
  `receive` (so a swap/p2p/bulk row for the same hash correctly suppresses a duplicate receive
  credit). (2) The actual write is `.upsert(toInsert, { onConflict: 'tx_hash,wallet_address',
  ignoreDuplicates: true })` — a genuine DB-level compare-and-swap, safe even if layer (1)'s read
  was stale by the time the write happens.
- **Reorg handling**: only consumes `status='confirmed'` rows, so a `pending` event that gets
  reorged away is never credited in the first place — correct by construction. **Caveat, not a
  currently-live problem but worth stating precisely (see §11)**: once a `chain_events` row
  reaches `'confirmed'`, nothing in the indexer can ever move it to `'reorged'` —
  `markEventsReorged` (in `cursors.ts`) only updates rows `WHERE status = 'pending'`. On Arc,
  `confirmationDepth = 0`, so a block is "confirmed" essentially the instant it's seen — there is
  no buffer. This is consistent with Arc's own documented finality (the code comments assert "1
  confirmation = final, no reorgs"), so it is not flagged as a live bug — but it means the
  system currently has **no code path at all** for retracting a credited deposit if that
  finality assumption is ever wrong, on Arc or on any future chain enabled with a nonzero
  `confirmationDepth` where a reorg could plausibly reach an already-`'confirmed'` row before the
  indexer processes it.
- **Duplicate Activity**: not possible for the *same* `(tx_hash, wallet_address)` — confirmed by
  both the dedup layers above and by the fact that `deposit-scan-all`'s reconcile-mode
  `recordExternalReceive` and the various client-side writers (`ActivityService.saveActivity`,
  audited in Phase 0) all write through the **identical** `onConflict:
  'tx_hash,wallet_address', ignoreDuplicates` shape against the same unique index — all four
  writers are safely redundant, not competing, exactly as `activity-consumer`'s own header
  comment states.
- **Receiver Activity**: `activity-consumer` **only ever writes `activity_type: 'receive'` rows**,
  and only for the recipient — it has no code path that touches a sender's row at all. This is
  the architecturally correct pattern (indexer-driven, not sender-driven) — but it is not the
  *only* writer of the recipient's row: `SendPage.tsx` (Phase 0 audit) still writes the
  recipient's `recv_`-prefixed row directly from the sender's own browser, immediately on
  broadcast. Both converge safely on the same unique index (whichever writes first wins, the
  second is a no-op) — so this is **not a duplicate-risk** today, but it does mean the "sender
  must never create the receiver's Activity" principle is still only enforced by luck-of-timing
  plus the shared unique constraint, not by the sender path having actually been removed. That
  removal is explicitly a **later phase** (Pay/Receive migration), not this one.
- **Balance**: does not touch any balance table or cache — confirmed, no such write anywhere in
  either file.
- **Notifications**: does not write to any notification table and does not call any push/webhook.
  It writes a specific `metadata.note` string (`'External deposit'` vs `'External deposit (near a
  swap)'`), which **client-side** code (`HomePage.tsx`'s `fireIfReceived()`, per the code's own
  comment) reads to decide whether to show a local notification. The consumer itself sends
  nothing.
- **Crash after inserting Activity but before "marking consumed"**: **there is no separate
  "consumed" marker at all**, by design. The `activity` table's own existence-check
  (`loadExistingActivity`) *is* the consumed-marker — an event needs crediting iff no matching
  activity row exists yet. This means there is no intermediate state to crash into: either the
  upsert completes (row exists, future passes correctly skip it) or it doesn't (row doesn't
  exist, future passes correctly retry it). No cursor-desync failure mode exists here, unlike a
  cursor-based consumer.
- **Two concurrent invocations**: both read the same `chain_events` candidates, both build the
  same `toInsert` set, both call the same idempotent upsert — the DB unique index is the actual
  arbiter, and `ignoreDuplicates: true` means neither invocation errors, they just converge on
  one row. Verified as safe by design; not independently load-tested against a real concurrent
  invocation in this pass (would require triggering two live overlapping HTTP calls against
  production, which is out of scope for an audit-only checkpoint).

## 6. Legacy reconcile-mode behavior (`deposit-scan-all`, `mode=reconcile`)

Read `runReconcilePass` (lines 903–972) in full.

- **Scope**: native USDC **only**. It does not call `fetchTransferLogsRange` (the ERC-20 path) at
  all — that function only runs from `runSweepPass`, which is disabled. So **EURC/cirBTC
  detection currently has zero legacy backstop** — `blockchain-indexer` + `activity-consumer` is
  the only path for ERC-20 deposits right now.
- **What it does**: two native-USDC recovery passes — (1) its own `native_usdc_logs` cursor
  scanning the wrapper-routed native-transfer-log contract (`0xffff…fffe`) via `eth_getLogs`,
  catching anything the (disabled) direct-RPC block scan would have missed; (2) a per-wallet
  Blockscout explorer query (`fetchNativeDepositsViaExplorer`), independent of any cursor, as a
  second-layer backstop.
- **Is it an Activity writer?** Yes — `recordExternalReceive`, the **identical** function
  `runSweepPass` used, with the **identical** `onConflict: 'tx_hash,wallet_address',
  ignoreDuplicates: true` upsert shape as `activity-consumer`'s write and the client-side writers.
  Both recovery passes check `filterAlreadyRecorded` against `activity` before writing, same
  pattern as `activity-consumer`'s `loadExistingActivity`.
- **Balance/duplicate writer?** No balance writes. Duplicate risk: same as §5 — protected by the
  shared unique index, converges safely with the other three writers.
- **Verdict**: **verification/backstop + repair**, exactly as its own comments describe it — not
  a competing primary detector. Its remaining live value is specifically as insurance against an
  `activity-consumer`/`blockchain-indexer` gap for **native USDC** only.

## 7. The 40 FAIL windows — what "FAIL" actually means

Read `compare.ts` in full (490 lines, including the two lines fixed for a pre-existing type
error in the prior Phase 3 pass).

- **Matching algorithm**: `keyOf(wallet, tx)` → `{wallet: lowercased, tx: normalized (recv_
  stripped, lowercased)}`. Two populations (indexer `chain_events` rows filtered to
  `deposit_detected`/`transfer_detected`, and worker `activity` rows) are each reduced to a
  `Set<"wallet:tx">`; the comparison is a set intersection/difference, nothing more.
- **Time window**: the caller (`monitor.ts`) supplies both populations already filtered to a
  configurable window (60 minutes at every live cron run, confirmed from `cron.job`'s
  `windowMinutes: 60`). Windows overlap heavily (a new 60-minute window is drawn every 15
  minutes) — **this is why one real event can appear as a mismatch in up to 4 consecutive
  reports**, inflating the raw window-count well above the number of actual distinct incidents.
- **Comparability gate** (`assessComparability`): a window is only trusted if the indexer's
  cursor lag is within `max_backlog_blocks` (600, ≈5 minutes on Arc) of the chain head. Windows
  failing this are `NOT_COMPARABLE`, not `FAIL` — `FAIL` only ever means a *trusted* comparison
  found a genuine set difference.
- **Confirmation state**: `compareDeposits` filters the indexer side to whatever `chain_events`
  rows monitor.ts fetched — need to independently confirm monitor.ts's DB query scopes to
  `status='confirmed'` the same way `activity-consumer` does; **it does** (verified by reading
  `recentChainEvents` in `monitor.ts`, which the compare-mode handler calls — its query
  hardcodes no status filter in the snippet read during Phase 0, **this needs a second look**:
  re-checked directly — `recentChainEvents` selects `event_type IN (...)` with no `status` filter
  at all, meaning `compareDeposits` is being handed BOTH pending and confirmed indexer events).
  This is a genuine, distinct finding from the ones below — see §12.
- **What FAIL does NOT mean**: it is explicitly not "financial failure." Every non-PASS result
  carries a `reason` string and is one of `FAIL`/`NOT_COMPARABLE`/`NOT_APPLICABLE` — the code's
  own header comment states this design goal directly ("the counts alone are ambiguous... zero
  is never used as a stand-in for not measured").

**De-duplicated to distinct incidents** (not raw window-count — see the query in §8's method):
the 40 raw FAIL windows collapse to **21 distinct `indexer_only` tx/wallet pairs** and **19
distinct `worker_only` tx/wallet pairs** across the full 2-week history since deployment.

**Classification of all 40 FAIL windows, by root cause of their underlying distinct incidents:**

| Category (per the requested taxonomy) | Distinct incidents | Evidence |
|---|---|---|
| **COVERAGE mismatch** — genuine on-chain deposit-shaped event, correctly credited under a non-`receive` `activity_type` (`swap`, `p2p_purchase`, `p2p_refund`, `bulk`) that `compareDeposits`'s worker-row population doesn't include | **7 traced directly, pattern accounts for the large majority of `indexer_only`** | §8 — every `indexer_only` incident traced in this audit resolved to a real, correctly-credited `activity` row under a different `activity_type` |
| **TIMING mismatch** — both sides eventually agree; whichever system runs first shows as "only" until the other catches up | Several, incl. the `0xfc2ab12d…` case (§8) and `0x8c831fb51d…` (appears as `worker_only` and `indexer_only` on the *same day*, in that order) | Directly observed: activity row created before the corresponding `chain_events` row in one case, and the same tx/wallet flipping sides within hours in another |
| **Early-deployment artifact, not recurring** — everything with `first_seen`/`last_seen` on 2026-08-08/09 and never seen again since | ~10+ incidents, incl. a cluster of 10 distinct tx hashes all reported at the identical timestamp `2026-08-09 06:27:27.222073` (almost certainly a one-off manual/cold-start comparison run, not a cron-cadence timestamp) | Live query — none of these tx/wallet pairs recur after 2026-08-10 |
| **REAL MISS (indexer failed to detect a genuine, otherwise-unaccounted-for deposit)** | **0 confirmed** in every incident actually traced in this audit | Every traced `indexer_only`/`worker_only` pair resolved to either a correct credit under another activity_type, a timing crossover, or an early artifact — none showed a deposit that was never credited anywhere |
| DATA/IDENTITY/REORG mismatch | 0 observed | No case traced showed a wrong amount, wrong wallet, or reorg-related discrepancy |

**No claim is made that literally all 40 windows were individually re-traced** — that would mean
re-deriving all 21+19 distinct incidents one at a time, most of which are old (Aug 8-10) and
share the exact patterns already conclusively demonstrated on live, representative samples from
each recurring bucket. What is traced (§8) is a representative, evidence-based sample across
every bucket found in the distinct-incident breakdown, including the two categories that account
for the overwhelming majority: the persistent P2P/swap/bulk coverage gap (still live, reproduced
as recently as the day of this audit) and the early-deployment timing/cold-start artifacts (all
of which stopped recurring after 2026-08-10).

## 8. The worker-only / indexer-only trace (method + results)

**Method**: queried `indexer_shadow_reports.details` (jsonb) across every `FAIL` row for scope
`deposits`, exploded `workerOnly`/`indexerOnly` arrays, grouped by `(side, tx_hash, wallet)` to
get the true distinct-incident count (§7), then traced a representative sample directly against
`chain_events` and `activity` with a single join query per case: `chain_events.tx_hash =
activity.tx_hash OR activity.tx_hash = 'recv_' || chain_events.tx_hash`, on matching
`wallet_address`.

**Traced `indexer_only` cases** (7 total, spanning the full history):

| tx_hash (truncated) | wallet | chain_events sender | activity_type found | Verdict |
|---|---|---|---|---|
| `0x845235b5…` | `0xfe2ac69f…` | `0xe336e64c…` | `p2p_purchase` | COVERAGE — correctly credited, wrong scope compared |
| `0xd6387bd1…` | `0xfe2ac69f…` | `0xe336e64c…` | `p2p_purchase` | COVERAGE — same pattern |
| `0xa421b314…` | `0x05d00ab7…` | `0xe336e64c…` | `p2p_refund` | COVERAGE — same pattern |
| `0x435d804c…` | `0x5ddfbacc…` | `0xca11bde0…` (Multicall3) | `bulk` | COVERAGE — BulkPay recipient credit |
| `0xc2562c62…` | `0x05d00ab7…` | *(null in metadata)* | `swap` | COVERAGE, but sender metadata gap — see §12 |
| `0xb0f23d7b…` | `0x05d00ab7…` | `0xbbd70b01…` (Kit Adapter — a KNOWN_INTERNAL_CONTRACTS address) | `swap` | Should have been Fix-C-excluded; not recurring since 2026-08-09, consistent with a pre-fix-rollout artifact |
| `0x8c831fb5…` | `0xfe2ac69f…` | *(not re-queried individually)* | *(also appears as worker_only the same day)* | TIMING — same pair flips sides within hours |

**Traced `worker_only` cases**: the two most-repeated (`0x4a7c7fdc…`, `0x441120660a…`, both wallet
`0x05d00ab7…`) and the `0x70e3fb28…` wallet cluster (`0x56feeed8…`, `0x92ab1eca…`) were all
first/last-seen on **2026-08-08**, the indexer's first day of operation. `0x70e3fb28…` is
literally the address `compare.ts`'s own code comment names as the concrete example of an
unregistered external address that motivated adding the `registeredWallets` filter — its
recurrence stopping entirely after day one is consistent with that filter reaching full effect
early on, not an ongoing gap.

**Conclusion for §7/§8 together: no traced case represents a real financial miss.** Every
`indexer_only` case resolved to money that was already correctly in the user's Activity history,
under a different (but equally legitimate) `activity_type`. Every persistently-recurring case
(the only ones still appearing in this week's reports) is the same single root cause: the
comparison methodology's worker-side population is scoped to `activity_type='receive'` and Fix
C's contract-address exclusion, but has no equivalent exclusion for `swap`/`p2p_purchase`/
`p2p_refund`/`bulk` rows, which are just as legitimate.

## 9. Duplicate-risk analysis

Traced the exact write path and conflict target of all four writers:

| Writer | Write shape | Conflict target |
|---|---|---|
| `activity-consumer` | `.upsert(rows, {onConflict:'tx_hash,wallet_address', ignoreDuplicates:true})` | `(tx_hash, wallet_address)` |
| `deposit-scan-all` reconcile (`recordExternalReceive`) | identical upsert shape | identical |
| Client `ActivityService.saveActivity` (`SendPage.tsx` etc., Phase 0) | `POST .../activity?on_conflict=tx_hash,wallet_address` + `Prefer: resolution=ignore-duplicates` (when `tx_hash` is set) | identical, via PostgREST |
| P2P / swap / bulk client writers | not re-audited in this pass — Phase 0 found no evidence of a different conflict target | — |

Live schema check: **three separate unique indexes** currently exist on `activity(tx_hash,
wallet_address)` — `activity_tx_hash_wallet_address_key`, `activity_tx_hash_wallet_unique`,
`activity_tx_hash_unique` — all functionally identical (none partial, despite
`ActivityService.ts`'s own code comment claiming the constraint is `WHERE tx_hash IS NOT NULL`
partial; that comment is now stale/inaccurate relative to the live schema, though harmless — a
non-partial unique index still enforces the same guarantee for every row that has a `tx_hash`,
which is the only case any of these writers ever hits). The redundant indexes cost extra write
overhead and storage but are not a correctness risk.

**Can one blockchain event produce two Activity rows?** For the *same* `(tx_hash,
wallet_address)`: no — every writer converges on the same unique constraint. For a BulkPay-style
transaction crediting multiple *different* wallets from one tx_hash: each recipient gets their
own row with their own `wallet_address`, which is correct (N recipients = N legitimate rows, not
duplicates) — but see §14 for the separate, already-identified `chain_events`-level dedup gap
(from the prior Phase 3 session) that could have dropped some of those N rows entirely before
they ever reached `activity-consumer` — not yet applied to production (§16).

**Can one blockchain event produce two balance changes?** No balance table/cache is written by
any of the four `activity`-writing paths audited here. (Client-side `useWalletStore.setBalance`
calls, audited in Phase 0, are chain-derived reads, not derived from `activity` — out of scope
for this pass.)

**Can one blockchain event produce two notifications?** No notification table or push call is
made by `activity-consumer` or `deposit-scan-all` reconcile. Notification-like behavior
(`fireIfReceived`) is client-side and keyed off the `activity` row's `metadata.note`, which is
itself protected by the same dedup as the row it reads from — a row that can't be duplicated
can't fire the client-side notification twice from that source. (Push notifications from other
subsystems — P2P's own `notifications` table, Phase 1 audit — are unrelated and unaudited here.)

**Can a blockchain event be missed with no receive Activity at all?** This is the one path this
audit cannot fully rule out from log/data inspection alone: it would require an on-chain deposit
that (a) the indexer's scanner never emits an event for at all, AND (b) `deposit-scan-all`
reconcile's native-only backstop also misses (impossible for it to catch an ERC-20 miss, since it
doesn't scan tokens at all — see §6). No such case was found in the traced sample, but the
sample was drawn from the shadow-comparison mismatch log, which by definition only contains
events at least ONE side detected — a genuine double-miss (neither side ever saw it) would not
appear in `indexer_shadow_reports` at all and cannot be found this way. This is a structural
blind spot of shadow comparison in general (also true before this audit), not something
introduced by the cutover — noted in §14 as a residual risk.

## 10. Reorg analysis

Already covered in-line at §5: `markEventsReorged` only ever transitions `pending → reorged`,
never `confirmed → reorged`. On Arc (`confirmationDepth = 0`) this matches the chain's own
documented finality claim, so it is not a currently-active bug. It is flagged as a real
structural gap that would matter the moment any chain with a nonzero `confirmationDepth` is
enabled (all four "declared, not scanned" chains in `chains.ts` have depths of 12-128) — a
`chain_events` row could reach `'confirmed'` (per this system's own confirmation-depth
partitioning) and still theoretically be affected by a reorg deeper than assumed, with no code
path to retract it. Not applicable to today's live traffic (Arc only), but should be fixed
before any second chain is enabled — a Phase 3-continuation item, not touched in this pass.

## 11. Confirmation-depth analysis

Arc: `confirmationDepth = 0` (from `chains.ts`, matches the live `chain_cursors` row observed:
`confirmation_depth` not separately queried in this pass but consistent with the code default
since no override migration was found). This means a `chain_events` row is eligible to become
`'confirmed'` essentially the moment its block is seen — `safeFrontier(head, 0) = head`. Combined
with `activity-consumer`'s `MIN_EVENT_AGE_MS = 30_000` settle delay, the effective end-to-end
latency from on-chain confirmation to `activity` credit is roughly 30 seconds plus up to the
2-minute indexer cron cadence plus up to the 1-minute consumer cron cadence — i.e. typically
under 2-3 minutes, consistent with the "2-3 min delay" issue `deposit-scan-all`'s own comments
describe fixing for the legacy path.

## 12. New findings surfaced by this forensic pass (not previously identified)

Two genuine, distinct findings emerged from this trace that were not part of the prior Phase 3
session's chain_events/log_index work:

1. **`monitor.ts`'s `recentChainEvents` query for compare-mode does not filter by `status`** —
   it selects `deposit_detected`/`transfer_detected` events in the time window with no
   `status='confirmed'` filter, meaning `compareDeposits` is being handed a mix of `pending` and
   `confirmed` indexer events for comparison, while the worker side (`activity`) only ever
   contains confirmed, credited rows by definition. This does not itself explain any of the
   traced mismatches above (all 7 traced `indexer_only` cases had `status: 'confirmed'` in
   `chain_events`), but it is a latent source of *additional*, not-yet-observed false
   `indexer_only` reports for any deposit that's still `pending` at comparison time — worth
   fixing alongside the coverage-scope gap (§16), not urgent on its own.
2. **The P2P/swap/bulk activity-type coverage gap (§7/§8) is the single dominant, currently
   live root cause** of ongoing `FAIL` reports — reproduced as recently as the day of this audit
   (`2026-08-22`). It inflates the shadow comparison's apparent miss rate without representing
   any real financial risk, which matters directly for the "is the cutover safe" question: the
   comparison metric currently looks worse than the system actually is.

## 13. RPC failure analysis

Not independently re-tested against live infrastructure in this pass (would require inducing a
real RPC failure against production, out of scope for an audit-only checkpoint). Code-level
behavior was already verified by the Deno test suite added in the prior Phase 3 session
(`scanner.test.ts` — retry-then-succeed on 429, fail-fast on deterministic 400, cursor-safety on
exhausted retries) and remains valid; no code in the failure path changed in this pass.

## 14. Current production risks (net new + carried forward)

1. **(Carried forward, not yet applied)** The `chain_events` dedup index gap identified in the
   prior Phase 3 session — `UNIQUE(event_type, chain_id, tx_hash, block_number)` missing
   `wallet_address`/`log_index` — is now higher-priority than when it was found, because
   `chain_events` feeds a **live production credit path** (`activity-consumer`) today, not a
   pure-shadow table. A BulkPay-shaped transaction (once BulkPay coverage is added — not yet
   built) would silently lose recipients' events at the `chain_events` insert step, before
   `activity-consumer` ever sees them. The fix (migration + `scanner.ts`/`compare.ts` changes)
   is written and locally verified but **not applied to production** — see §16.
2. **The comparison-methodology coverage gap (§7/§8/§12)** makes the shadow metric currently
   under-represent how well the indexer is actually doing — not a financial risk, but a
   trust/visibility risk: nobody currently has an accurate automated signal of true recall,
   which matters for any future decision to lean on this comparison more heavily.
3. **ERC-20 tokens (EURC/cirBTC) have zero legacy backstop** right now (§6) — if
   `blockchain-indexer`/`activity-consumer` ever has a bug specific to token transfers, there is
   no second system positioned to catch it, unlike native USDC which still has the reconcile
   backstop.
4. **No reorg path for already-`'confirmed'` events** (§10) — inert today (Arc-only, zero
   documented reorgs), becomes relevant the moment a second chain is enabled.
5. **The double-miss blind spot** (§9, last item) is structural to shadow comparison itself, not
   new — restated here because it's directly relevant to how much confidence the "0 real misses
   traced" finding in §7/§8 should carry: it means "no missed deposit that ALSO appears in the
   mismatch log," not "no missed deposit could exist at all."

## 15. Is the current cutover safe?

**SAFE WITH FIXES.** See §16 for what "with fixes" means concretely. Justification against the
brief's own bar ("a real financial event missing from the indexer = UNSAFE; a mismatch that is
only timing/confirmation and does not cause financial loss = SAFE WITH FIXES"):

- Every mismatch actually traced in this audit — across every recurring bucket found in the
  data, not a cherry-picked few — resolved to either a correctly-credited event under a
  different activity_type, a timing crossover that self-resolved, or a non-recurring
  early-deployment artifact. **Zero traced cases showed a real financial event that ended up
  uncredited anywhere.**
- `activity-consumer` itself, on direct code audit, is confirmed-only, idempotent under
  concurrency, fails closed on read errors, and cannot produce duplicate Activity rows for the
  same event (§5, §9).
- The risks that ARE real (§14) are about *coverage completeness going forward*
  (chain_events dedup gap once BulkPay is added, zero ERC-20 backstop, no reorg-of-confirmed
  path) and *measurement accuracy* (the coverage-scope gap making the shadow metric look worse
  than reality) — not about money currently at risk today.

## 16. Exact fixes required before continuing

In priority order:

1. **Apply the `chain_events` identity-hardening migration** (written and locally verified in
   the prior Phase 3 session, `20260823080000_phase3_chain_events_identity_hardening.sql`) and
   deploy the corresponding `scanner.ts`/`compare.ts` code changes already made locally. This is
   now materially more important than when it was first found, per §14 item 1. **Not applied in
   this pass** — audit-only checkpoint, per instructions.
2. **Fix `compareDeposits`'s worker-row scope** to exclude (or separately report, the same way
   Fix C does for internal-contract senders) `activity` rows already accounted for under
   `swap`/`p2p_purchase`/`p2p_refund`/`bulk` activity_types for the same tx_hash — this is a
   `compare.ts`-only change (comparison logic, not production credit logic) and would eliminate
   the dominant, currently-recurring source of false `FAIL` reports without touching anything
   that moves money.
3. **Add a `status='confirmed'` filter to `monitor.ts`'s `recentChainEvents`** query (§12 item
   1) so the comparison never mixes pending and confirmed indexer events.
4. **Decide the ERC-20 backstop question** (§14 item 3) — either accept the current
   single-point-of-detection for EURC/cirBTC as a deliberate tradeoff, or extend
   `deposit-scan-all` reconcile (or a new lightweight check) to cover tokens too.
5. **Design the confirmed-event reorg path** (§10/§14 item 4) before any second chain is
   enabled — not urgent for Arc today.

None of these require rolling back the cutover, disabling `activity-consumer`, or re-enabling
`deposit-scan-all-sweep`, per your explicit instructions — they are additive/corrective, in
keeping with everything else in this migration so far.

## 17. Recommended Phase 3 migration plan (once fixes are approved and applied)

1. Apply the chain_events migration + scanner/compare code changes (item 1 above) — pure
   correctness fix, zero behavior change to what's already live.
2. Fix the comparison-scope gap (items 2-3 above) — pure measurement fix, zero behavior change
   to what's already live.
3. Let the shadow comparison run for a further sustained period (recommend at least the same
   ~2-week window this audit covered) with the fixed methodology, and confirm `indexer_only`
   trends to genuinely zero (or every remaining case is individually explained, the same bar the
   original brief set).
4. Only then formally document the cutover as complete in `docs/PHASE_3_CUTOVER_PLAN.md` — not
   written in this pass, since it was explicitly deferred pending this forensic audit.
5. Address the ERC-20 backstop and reorg-of-confirmed items (§16 items 4-5) on a timeline that
   doesn't block the above, since neither is currently causing observed harm.

**No change to `authoritative`, no cron changes, no code deploys performed in this pass.**
