# Phase 3 — Fixes Applied

Status: all three approved fixes implemented and verified. **Fix 1's migration was applied to
production** (with a pre-apply safety check, per your instructions). Fixes 2/3/4's code changes
are committed to the repository but **not deployed** — this environment has no Supabase Edge
Function deploy capability (only SQL execution/migration tools), so `scanner.ts`, `compare.ts`,
and `monitor.ts`'s changes require your own `supabase functions deploy` step. This is stated
explicitly, not glossed over — see "PRODUCTION DEPLOYMENT RESULT" below.

No feature migration, no `authoritative` flag change, no cron change, no other file outside the
three fixes' direct scope was touched.

---

## FIX 1 — `chain_events` identity hardening

### Migration safety check (performed before applying)

1. **Inspected the live schema** (`information_schema.columns`) immediately before applying —
   confirmed `chain_events` still had none of the five new columns, matching what the migration
   expects (no drift since the migration was written).
2. **Checked for existing duplicate rows** under the new key. Query:
   ```sql
   select event_type, chain_id, tx_hash, wallet_address, count(*)
   from public.chain_events where tx_hash is not null
   group by event_type, chain_id, tx_hash, wallet_address having count(*) > 1;
   ```
   **Result: zero rows.** Out of 92 total rows / 92 distinct `tx_hash` values, no two rows
   shared `(event_type, chain_id, tx_hash, wallet_address)` — safe to create the new unique
   index with no remediation needed. (This makes sense given §13 of
   `docs/PHASE_3_INDEXER_AUDIT.md`: nothing that produces multi-recipient events, like BulkPay,
   is decoded yet — the exact scenario the old index couldn't handle has literally never
   occurred in production data, only been proven possible in a controlled reproduction.)
3. **No rows were deleted, altered, or migrated.** The fix is additive (5 new nullable columns)
   plus one index replacement (`DROP INDEX` + `CREATE UNIQUE INDEX`, both on metadata only — no
   data rewrite).

### Migration applied

`supabase/migrations/20260823080000_phase3_chain_events_identity_hardening.sql`, applied via
direct SQL execution against the `MeshPort` project (`cvvpzfvzweszuuxvaayb`).

**Verified post-apply:**
- All 5 new columns present (`log_index`, `contract_address`, `event_signature`, `block_hash`,
  `transaction_index`), all nullable.
- New index confirmed live: `chain_events_dedup_idx` on
  `(event_type, chain_id, tx_hash, wallet_address, COALESCE(log_index, '-1'::integer))
  WHERE (tx_hash IS NOT NULL)` — matches the migration file exactly.
- **All 92 pre-existing rows preserved untouched** (`log_index IS NULL` for all 92, as expected
  — they predate the scanner code that would populate it; nothing lost, nothing corrupted).

### Identity now correctly supports

- 1 transaction → multiple Transfer logs → multiple recipients: `wallet_address` +
  `log_index` together distinguish every leg.
- BulkPay/Multicall3: proven via a real before/after reproduction (see FIX 2 below) — a 3-recipient
  batch that failed entirely under the old index now inserts all 3 rows.
- Swap: two legs on the *same* wallet (SWAP_DEBIT/SWAP_CREDIT-shaped) are on different token
  contracts already handled as separate scan-loop iterations; not a new risk this fix addresses,
  but the same identity now also correctly distinguishes two Transfer logs to the *same* wallet
  in one tx if that ever occurs (tested — see FIX 2).
- CCTP: not decoded by this indexer at all (§7 audit) — not applicable to this fix, noted for
  completeness.
- Native top-level transfers (no `log_index`): `COALESCE(log_index, -1)` keeps the identity
  deterministic and correctly collision-safe for that path specifically — verified both for a
  fresh insert and a cross-pass re-insert.

---

## FIX 2 — Scanner / event identity

### Scanner changes

`supabase/functions/blockchain-indexer/scanner.ts` — three event-construction sites (native
top-level scan, native-transfer-log scan, ERC-20 log scan) now populate `log_index`,
`contract_address`, `event_signature`, `block_hash`, `transaction_index` directly from RPC
response fields already being read (**zero additional RPC calls**). `log_index`/
`contract_address`/`event_signature` are `null` for the native top-level path (no log exists
there by nature). These changes were made and locally verified in the prior Phase 3 session;
unchanged in this pass except for the new regression test below.

### Verified

| Scenario | How verified |
|---|---|
| Multiple Transfer logs in one tx, multiple recipients | `scanner.test.ts` — a 3-recipient BulkPay-shaped tx produces 3 distinct events with distinct `log_index` |
| Same tx hash, different log indexes | Same test — all 3 events share identical `(event_type, chain_id, tx_hash, block_number)` (the OLD index key) but distinct `(…, wallet_address, log_index)` (the NEW key) |
| Same recipient receiving multiple transfers in one transaction | **New this pass** — `scanner.test.ts`: two separate Transfer logs to the SAME wallet in one tx produce two distinct events, distinguished only by `log_index` |
| BulkPay-shaped transaction | Same 3-recipient test above |
| Native path has no log_index | `scanner.test.ts` — native top-level transfer: `log_index`/`contract_address`/`event_signature` all `null`, `block_hash`/`transaction_index` populated free |

**10/10 `scanner.test.ts` tests pass** (was 9 before this pass; +1 new same-recipient test).

---

## FIX 3 — Shadow comparison classification

### Compare changes

`supabase/functions/blockchain-indexer/compare.ts`:

- New exported classification taxonomy: `MismatchClassification` = `RECEIVE_MATCH |
  ACCOUNTED_FOR_OTHER_ACTIVITY | TRUE_INDEXER_ONLY | WORKER_ONLY | TIMING_DIFFERENCE |
  NOT_COMPARABLE`.
- New `ACCOUNTED_FOR_ACTIVITY_TYPES = {swap, bulk, p2p_purchase, p2p_refund}` — built directly
  from the live-traced evidence in `docs/PHASE_3_REAL_STATE_AUDIT.md` §7/§8, not guessed.
- `compareDeposits` now takes a broader `workerRows` population (any of the 5 comparable
  `activity_type`s, not just `receive`) and classifies every one-sided mismatch into exactly one
  bucket, in a strict, safety-preserving order (receive-match check first, then Fix C
  internal-contract exclusion, then accounted-for-other-activity, then timing, then — only if
  none of those apply — a genuine `TRUE_INDEXER_ONLY`/`WORKER_ONLY`). This mirrors Fix C's own
  documented ordering rule exactly, for the same reason: a check applied before matching could
  mask a real miss; applied only after a match attempt fails, it can only ever reclassify an
  extra.
- `TIMING_DIFFERENCE_THRESHOLD_MS = 5 minutes`, sized from the measured end-to-end latency in
  `docs/PHASE_3_REAL_STATE_AUDIT.md` §11 (indexer cron + settle delay + consumer cron ≈ 2-3
  min), with a safety margin.
- **Nothing is hidden.** The raw `indexerOnly`/`workerOnly` totals are unchanged in meaning and
  still include every classified item — `accountedForOtherActivity`/`trueIndexerOnly`/
  `timingDifference` are ADDED breakdowns, not replacements. `recallPct`'s formula changed
  (documented in-code and in the affected pre-existing test) from
  `matched/(matched+workerOnly)` to `(matched+accountedForOtherActivity)/(matched+
  accountedForOtherActivity+trueIndexerOnly)` — a measure of the indexer's own detection rate,
  which is what the metric is actually meant to answer.
- `status` (`PASS`/`FAIL`) is now driven by `trueIndexerOnly`/`trueWorkerOnly` (the *unclassified
  residual* after removing accounted-for and timing items), not the raw totals. A window whose
  only "mismatches" are all accounted-for-elsewhere and/or too-recent-to-judge is a genuine
  `PASS`; a window whose *only* content is timing-difference items (nothing conclusively matched
  either) reports `NOT_COMPARABLE` rather than a forced `PASS` or `FAIL` — honest about not
  having proven anything yet, the same principle already used for empty/fully-suppressed
  windows.

### Verified

12 new tests added to `compare.test.ts`, covering:
- All four `ACCOUNTED_FOR_ACTIVITY_TYPES` individually classify correctly and turn a would-be
  `FAIL` into a `PASS`.
- Raw `indexerOnly` is confirmed unchanged (still counts the accounted-for item) — proving
  nothing is silently hidden, only relabeled.
- A genuine miss (no activity row of *any* type) is still `TRUE_INDEXER_ONLY` and still fails.
- Ordering safety: a real `receive` match still wins over an accounted-for-other-activity
  classification when both could theoretically apply.
- Timing carve-out: a very recent one-sided mismatch is `TIMING_DIFFERENCE`; the *same* event,
  aged past the threshold, becomes `TRUE_INDEXER_ONLY`. Applied symmetrically to `worker_only`.
  Missing/unparseable timestamps are treated as *not* recent (no benefit of the doubt).
- One pre-existing test's `recallPct` expectation was updated (from `0` to `null`) to match the
  intentional formula change, with the reasoning written directly into the test.

**26/26 `compare.test.ts` tests pass** (was 14 before this pass; +12 new).

---

## FIX 4 — Confirmed filter

### Monitor changes

`supabase/functions/blockchain-indexer/monitor.ts`:

- `recentChainEvents` now selects `status` and `created_at` (previously neither), and adds
  `.eq('status', 'confirmed')` — the query-level fix requested. Previously had **no status
  filter at all**, confirmed as a real gap in `docs/PHASE_3_REAL_STATE_AUDIT.md` §12.
- `recentWorkerDeposits` now selects `activity_type` and `created_at`, and widens
  `.eq('activity_type','receive')` to
  `.in('activity_type', ['receive', ...ACCOUNTED_FOR_ACTIVITY_TYPES])` — the data-plumbing Fix 3
  needs.
- `persistReport` and the `runCompare` response shape both now carry the full Fix 3 breakdown
  (`accountedForOtherActivity`, `trueIndexerOnly`, `timingDifference` and their key arrays), so
  a persisted `indexer_shadow_reports` row and the live HTTP response show the same information.

`compare.ts` itself *also* re-checks `status` defensively (Fix 3/4 section above) — belt and
suspenders, and specifically what makes the rule unit-testable without a live database, since
`monitor.ts`'s own DB query can't be exercised by `deno test` in this sandbox (no network access
to `jsr:@supabase/supabase-js`, a pre-existing, already-documented environment limitation — see
"TYPECHECK" below).

### Verified

4 new tests in `compare.test.ts` proving exactly the requested cases:
- `pending` chain_event → excluded from comparison (window becomes `NOT_COMPARABLE`, not `FAIL`
  with a phantom miss).
- `confirmed` chain_event → included (genuinely compared, correctly reported as a miss when it
  is one).
- `reorged` chain_event → excluded.
- An event with **no** `status` field at all → not filtered (backward compatibility for any
  caller/test that never populates it — this is the same defense-in-depth vs. query-level split
  used elsewhere in this codebase).

---

## DATABASE CHANGES

One migration applied to production: `20260823080000_phase3_chain_events_identity_hardening.sql`
— 5 new nullable columns on `chain_events`, 1 index replacement. No other schema change. No
data deleted or altered. Full detail and verification queries in FIX 1 above.

## MIGRATION SAFETY CHECK

Performed and passed — see FIX 1. Zero duplicate rows found under the new key; zero remediation
needed; nothing deleted.

## DUPLICATE ROW CHECK

Zero duplicates found (92/92 rows, all distinct under both the old and new identity). Full query
in FIX 1.

## SCANNER CHANGES

See FIX 2. Files: `scanner.ts` (from the prior session, re-verified this pass),
`scanner.test.ts` (+1 new test this pass, 10/10 passing).

## COMPARE CHANGES

See FIX 3. File: `compare.ts` (substantial addition this pass — classification taxonomy, new
exported constants, rewritten `compareDeposits`, `compareClaims` updated for the wider
`ComparisonResult` shape). `compare.test.ts`: +12 new tests, 1 pre-existing test's expectation
intentionally updated, 26/26 passing.

## MONITOR CHANGES

See FIX 4. File: `monitor.ts` (query changes to `recentChainEvents`/`recentWorkerDeposits`,
`persistReport`/`runCompare` response shape extended). No dedicated `monitor.test.ts` — its DB
queries can't be unit-tested in this sandbox (no live-DB/mocking harness was built for it, and
its own logic is now thin enough — filter clauses, field selection — that `compare.ts`'s tests
cover the actual classification behavior that matters). Typechecked (see below).

## TEST RESULTS (exact, actually run — not invented)

| Suite | Before this pass | After this pass |
|---|---|---|
| `npx vitest run` (Phase 1 + Phase 2, npm/Node) | 180 passed | **180 passed** (unchanged — nothing in this pass touched `src/` or `server/`) |
| `deno test cursorMath.test.ts` | 9 passed | **9 passed** (unchanged) |
| `deno test scanner.test.ts` | 9 passed | **10 passed** (+1 same-recipient regression test) |
| `deno test compare.test.ts` | 14 passed | **26 passed** (+12 Fix 3/4 regression tests) |
| **Deno total** (`deno test .` in `blockchain-indexer/`) | 32 passed | **45 passed** |
| **Grand total** | 212 | **225** |

All numbers from actually executing the suites in this pass, not estimated.

## TYPECHECK

- `npm run typecheck` (root, `src/`): **clean**.
- `npm run typecheck:server` (`server/`): **clean**.
- `deno check scanner.ts`: **clean**.
- `deno check compare.ts`: **clean**.
- `deno check monitor.ts`: fails to resolve `jsr:@supabase/supabase-js@2` — **pre-existing
  sandbox limitation** (no network access to `jsr.io` in this environment), not a code defect.
  Re-verified `monitor.ts`'s own logic against a local stub for that one import (substituting
  `SupabaseClient = any` via a Deno import map) — **clean** under that stub, confirming the
  edits themselves are type-correct; the real `jsr:` types simply can't be fetched here. Same
  limitation, same workaround, applied to `index.ts`/`cursors.ts`/`activity-consumer/index.ts`
  as an unmodified-file sanity check — all clean, confirming nothing outside the three fixes'
  files was affected.

## LINT

No ESLint config exists anywhere in this repository (confirmed in the Phase 2 report; `npm run
lint` fails identically on an unmodified checkout). No Deno lint config (`deno.json`) exists
either, so `deno lint` runs with Deno's default rule set. Ran it directly against the three
changed files:

```
deno lint scanner.ts compare.ts monitor.ts
```

**5 problems found — all 5 pre-existing, none on a line touched by any of the three fixes:**

| Rule | File:line | Pre-existing? |
|---|---|---|
| `no-import-prefix` (inline `jsr:` import) | `monitor.ts:14` | Yes — the top-level `SupabaseClient` import, unrelated to Fix 4's edits (which are all in `recentChainEvents`/`recentWorkerDeposits`/`persistReport`/`runCompare`, further down the file) |
| `no-explicit-any` ×4 | `scanner.ts:125,157,175,320` | Yes — all in `rpcCallRace`/`getHead`/native-block-scan helper signatures untouched by Fix 2 (Fix 2's only scanner.ts changes were the five new fields on three `events.push({...})` call sites) |

Zero new lint issues introduced by this pass. Not fixed here, since none are related to the
three approved fixes and this checkpoint's scope was explicitly "no other changes."

## PRODUCTION DEPLOYMENT RESULT

- **Database**: migration applied and verified live (FIX 1). This takes effect immediately —
  the next indexer pass that tries to insert a multi-recipient batch will now succeed instead of
  silently failing, even before any code redeploy, since the constraint fix is server-side.
- **Edge Function code** (`scanner.ts`, `compare.ts`, `monitor.ts`): changes are committed to the
  repository. **This environment cannot deploy Supabase Edge Functions** — only SQL
  execution/migration tools are available, no `supabase functions deploy` equivalent. Until you
  run that deploy step yourself, the LIVE `blockchain-indexer` and `activity-consumer` functions
  are still running the PRE-Fix-2/3/4 code:
  - The live scanner is still NOT populating `log_index`/`contract_address`/etc. on new rows
    (they'll insert successfully now, per Fix 1's schema fix, but without the identity fields
    populated — i.e. Fix 1 prevents the *failure mode*, but Fix 2's enrichment needs the code
    deploy to actually start writing those fields).
  - The live shadow comparison is still using the OLD classification (raw `indexerOnly`/
    `workerOnly` only, no `ACCOUNTED_FOR_OTHER_ACTIVITY`/`TIMING_DIFFERENCE` breakdown, no
    `status='confirmed'` filter) until `monitor.ts`'s deploy lands.
  - **Recommended next step on your end**: `supabase functions deploy blockchain-indexer` (covers
    `index.ts`, `monitor.ts`, `scanner.ts`, `compare.ts`, `cursors.ts`, `chains.ts`,
    `cursorMath.ts` as one function) — no other function needs redeploying for these three fixes.

## REMAINING RISKS

1. **Fix 2/3/4 not yet live** (above) — the database is safer immediately, but the improved
   observability (Fix 3/4) and the enrichment (Fix 2) only take effect after your deploy step.
2. Everything already flagged as out-of-scope-but-real in `docs/PHASE_3_REAL_STATE_AUDIT.md` §14
   is unchanged by this pass: zero ERC-20 legacy backstop, no reorg path for already-`confirmed`
   events, the structural "double-miss" blind spot inherent to shadow comparison itself. None of
   these were part of the three approved fixes.
3. `TIMING_DIFFERENCE_THRESHOLD_MS` (5 minutes) is a reasoned estimate from measured latency, not
   independently tuned against a large sample — worth revisiting once the fixed comparison has
   run for a while and real `TIMING_DIFFERENCE` durations can be checked against it.
4. `ACCOUNTED_FOR_ACTIVITY_TYPES` is exactly the four types found in this audit's trace. If a
   future feature introduces a new `activity_type` for money the indexer would also incidentally
   see (e.g. a ChatPay-specific type), it will need to be added here too, or the same false-`FAIL`
   pattern will reappear under a new label — worth a note in whichever future phase adds such a
   type.

## SHADOW OBSERVATION GUIDANCE (once deployed)

Per your instructions, do not declare the indexer authoritative based on this pass. After you
deploy Fix 2/3/4, watch:

- **`TRUE_INDEXER_ONLY`** — the metric that matters. Should trend toward (and stay at) zero for
  a sustained period.
- `ACCOUNTED_FOR_OTHER_ACTIVITY` — expected to absorb most of what used to inflate raw
  `indexerOnly`; a sanity check that Fix 3's classification is working as designed.
- `TIMING_DIFFERENCE` — should mostly resolve to `matched`/`ACCOUNTED_FOR_OTHER_ACTIVITY` within
  the next window or two; a `TIMING_DIFFERENCE` item that keeps reappearing past several windows
  is worth investigating as a possible real miss the threshold is currently masking.
- `NOT_COMPARABLE` from the new all-timing-difference branch — should be rare and short-lived if
  the threshold is well-tuned.
