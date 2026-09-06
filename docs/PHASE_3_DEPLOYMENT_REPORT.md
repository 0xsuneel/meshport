# Phase 3 — Deployment Checkpoint: Execution Report

Status: **Deployed and observed.** `supabase/functions/blockchain-indexer` was redeployed to
production with Fixes 2/3/4. Fix 1 (the database migration) was already live, as confirmed at
the start of this checkpoint.

---

## Pre-deployment audit (performed before touching anything)

**Content verification (git-diff equivalent — no `.git` exists in this checkout, so this was
done by direct content inspection instead):**

- Confirmed the exact set of changed lines in each of the three files by grepping for their
  specific markers: `scanner.ts` has the 5 new fields (`log_index`, `contract_address`,
  `event_signature`, `block_hash`, `transaction_index`) at exactly 3 event-construction sites
  (15 occurrences = 5 × 3, exactly as expected — no more, no fewer). `compare.ts` has exactly
  one definition each of `COMPARABLE_STATUS`, `MismatchClassification`,
  `TIMING_DIFFERENCE_THRESHOLD_MS`, `ACCOUNTED_FOR_ACTIVITY_TYPES`. `monitor.ts` has exactly the
  two expected query changes (`.eq('status','confirmed')` and the widened `.in('activity_type',
  ...)`).
- **No unrelated files included**: listed every file modified in this entire engagement
  (`find . -newer package.json`) and confirmed the only production code touched is the three
  named files plus their test files; the only other changes are documentation and the
  already-applied migration.
- **No secrets/keys included**: scanned all three files for private-key/API-key/password
  patterns. The only match was `TRANSFER_TOPIC0`, a public `keccak256` event-signature hash
  (not a secret — verifiable by anyone from the public ABI). No `Deno.env.get` calls exist in
  any of the three files at all (env vars are read in `index.ts`, which is unchanged, and
  threaded down as parameters).
- **No Phase 4 / Pay / Receive / Swap / Activity-writer / cron / authoritative-flag changes**:
  confirmed by the same file-modification list — none of those files or database objects appear
  in it.

**Deployment safety checklist (all 8 items):**

1. ✅ Migration already applied and verified (prior checkpoint).
2. ✅ New `chain_events` identity confirmed live (`chain_events_dedup_idx` on `(event_type,
   chain_id, tx_hash, wallet_address, COALESCE(log_index, -1))`).
3. ✅ All 92 pre-existing rows intact (re-verified immediately before deploying).
4. ✅ `scanner.ts` writes exactly the 5 new columns the live schema now has — confirmed by
   reading the live schema directly before writing the deploy payload.
5. ✅ `compare.ts` writes its classification breakdown into `indexer_shadow_reports.details`,
   which is `jsonb` (schemaless) — no migration needed for the richer payload, confirmed by
   checking the column type before deploying.
6. ✅ `monitor.ts`'s `mode=compare`/`mode=index` dispatch contract in `index.ts` is unchanged
   (only `monitor.ts`'s internal query logic changed, not its exported function signatures) —
   confirmed by diffing `index.ts` (unchanged, redeployed byte-identical) against what it
   imports from `monitor.ts`.
7. ✅ No new environment variables — confirmed via the same `Deno.env.get` grep above.
8. ✅ No pending migration — `chain_events` schema matches what the deployed code expects,
   verified directly against `information_schema.columns` immediately before deploying.

---

## Deployment

Fetched the **exact current live source** of all 7 files making up the `blockchain-indexer`
function bundle first (`get_edge_function`), confirming the pre-deploy baseline matched what the
forensic audit described. Deployed the same 7-file bundle — `index.ts`, `chains.ts`,
`cursors.ts`, `cursorMath.ts` unchanged, `scanner.ts`/`compare.ts`/`monitor.ts` updated — via
`deploy_edge_function`, preserving `verify_jwt: true` to match the existing configuration
exactly (no auth posture change).

**Result**: `version: 9 → 10`, `status: ACTIVE`, new `ezbr_sha256` confirming new content was
actually stored (not a no-op). This was independently re-verified by fetching the deployed
source a second time after the deploy call and confirming it contains the exact expected
markers (`ACCOUNTED_FOR_ACTIVITY_TYPES`, `trueIndexerOnly`, `.eq('status', 'confirmed')`, the 5
scanner fields) — not just trusting the deploy call's own success response.

---

## Post-deploy verification (per the required checklist)

**A. Indexer scan still produces chain_events** — ✅ **directly observed**. `chain_cursors`
shows `last_success_at` advancing (`2026-08-23 12:18:15`) and `sync_state: idle` after the
deploy, with `consecutive_failures: 0` and `last_error: null` sustained across the full
observation window. The new code runs without crashing.

**B. Multiple Transfer logs in one transaction remain separate** — **verified via code, not
directly observed on live traffic.** No multi-log transaction occurred during the observation
window (this testnet's traffic is sparse — confirmed zero new `chain_events` rows arrived at
all in the ~20 minutes observed). Confidence comes from: (1) the deployed source, fetched fresh
and confirmed byte-identical to what was intended to deploy, contains the exact `log_index`
population logic; (2) `scanner.test.ts`'s BulkPay-shaped 3-recipient test, which exercises
precisely this scenario deterministically, passes (10/10). This is disclosed as code-level
verification, not a live production observation, per your instruction not to judge success from
tests alone — the honest status is "deployed correctly, not yet exercised by real traffic."

**C. Same recipient + multiple transfers remain separate** — same status as B: verified by the
new `scanner.test.ts` regression test (added this session specifically for this case) and by
confirming the deployed source contains the logic; not observed on live multi-transfer traffic,
since none occurred in the window.

**D. Activity consumer still receives confirmed events** — `activity-consumer` was not modified
in this or any prior Phase 3 pass (confirmed via file-modification list). No new `chain_events`
arrived during the window for it to act on (0 new `activity` rows since deploy), so its
behavior on new data specifically was not exercised — but it continues to run on its normal
1-minute cron with no observed errors, and its input contract (`chain_events` rows with
`status='confirmed'`) is unchanged by Fix 1/2 (only new nullable columns were added; nothing it
reads was altered or removed).

**E. Compare reports now contain the full taxonomy** — ✅ **directly observed in production.**
The `compare` cron fired at `2026-08-23 12:30:00` (report ids 2929/2930) using the newly
deployed code, and `indexer_shadow_reports.details` for that real run contains
`trueIndexerOnly`, `accountedForOtherActivity`, and `timingDifference` as actual populated
fields (all `0`, since the window was quiet) — not a test fixture, an actual row written by
production code against production data.

**F. Pending events are excluded from comparison** — verified via `monitor.ts`'s deployed
source (`.eq('status', 'confirmed')` confirmed present) and via `compare.test.ts`'s dedicated
regression tests; not exercised by a live pending event during the window, since none existed at
observation time (no new events landed at all).

**G. Confirmed events are included** — same status as F: source confirmed, tests pass, no new
confirmed event happened to land during the window to observe directly. The 12:30 `compare`
report itself DID correctly process the existing 92 historical `chain_events` rows (all
`status='confirmed'`) with no error, which is a real, if indirect, confirmation the new query
filter works against production data without breaking anything.

**H. Reorged events are excluded** — verified via source + tests only; Arc has never reorged in
this system's history (`reorg_count: 0` throughout), so there is no live reorged event to
observe this against, on this deploy or any prior one.

---

## Observation window

**Duration observed**: ~20 minutes post-deploy (one `index` cron cycle directly confirmed
healthy at 12:18, one full `compare` cron cycle observed at 12:30). This is shorter than "several
comparison cycles" — being direct about that rather than stretching the claim. The `compare`
cron fires every 15 minutes, so one additional cycle was captured within the practical time
available for this checkpoint.

| Metric | Pre-fix baseline (from the forensic audit) | Post-deploy (12:30 cycle) |
|---|---|---|
| Total comparison windows observed this session | — | 1 (`compare` scope: `deposits`) + 1 (`claims`) |
| TRUE_INDEXER_ONLY | n/a (field didn't exist) | 0 |
| WORKER_ONLY (raw) | historically up to 4 per window | 0 |
| ACCOUNTED_FOR_OTHER_ACTIVITY | n/a (field didn't exist) | 0 |
| TIMING_DIFFERENCE | n/a (field didn't exist) | 0 |
| NOT_COMPARABLE | occurred historically (empty/lagging windows) | **1** — this specific window (empty, no events either side) |
| New errors | — | **0** (`last_error: null`, `consecutive_failures: 0` throughout) |
| New duplicate `chain_events` | — | **0** (`chain_events` count unchanged at 92; no insert attempted since no new events occurred) |
| Activity credit anomalies | — | **0** (`0` new `activity` rows since deploy — nothing to be anomalous) |

The single observed window was quiet (no on-chain activity during it), which is why every new
field reads `0` — this is `NOT_COMPARABLE`, not a `PASS`, and is reported as such rather than
implying a clean bill of health that wasn't actually tested by real traffic. **This does not
constitute proof that `TRUE_INDEXER_ONLY` will stay at zero under real load** — it only proves
the new code runs without error against production and writes the new fields correctly when
invoked. A meaningful trend read (the actual point of Fix 3) requires observation over enough
windows to catch real deposit traffic, which will need to happen over the hours/days following
this deploy, not within this single checkpoint.

---

## Summary

- Fix 1 (migration): live and verified, prior checkpoint.
- Fixes 2/3/4 (code): **deployed to production** this checkpoint, verified via independent
  source re-fetch (not just the deploy call's response), and confirmed running without error
  across one `index` cycle and one `compare` cycle.
- No unrelated change, no secret, no Phase 4 content, no cron/authoritative-flag change included
  — verified directly, not assumed.
- B/C/F/G/H are verified at the code/deploy level but **not yet observed against live multi-log
  or pending/reorged traffic**, since none occurred in the available observation window — stated
  plainly rather than implied as fully proven in production.

Per your instructions: **not** declaring Phase 3 complete based on this single window. Recommend
checking `indexer_shadow_reports` again after several more hours of real traffic before treating
`TRUE_INDEXER_ONLY` as a trustworthy trend.

**Not proceeding to Phase 4. Not migrating Pay/Receive/Swap. Not creating ledger_events.**
Stopping here per your instructions, pending your review.
