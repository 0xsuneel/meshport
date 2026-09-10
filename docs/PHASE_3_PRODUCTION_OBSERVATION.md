# Phase 3 — Production Observation Report

Status: **Extended observation performed. Phase 3 still NOT marked complete** — the window
observed, while it did capture real live traffic (unlike the first quiet window), is still far
short of "several hours," and one required check (multi-log transaction identity on live data)
still has zero natural occurrences to observe. Honesty about this gap is the point of this
report, not a reason to inflate the window or the conclusion.

**No code, config, cron, or flag was touched during this observation.** Confirmed at the end of
this session — `blockchain-indexer` remains at deployed version 10, `indexer_config.shadow_mode`
unchanged, no cron job's `active` state changed.

---

## Observation start / end

- **Start**: `2026-08-23 12:16:00 UTC` (the Fix 2/3/4 deployment from the prior checkpoint).
- **End (this report)**: `2026-08-23 13:31:12 UTC`.
- **Duration observed**: **~75 minutes**, not "several hours." This is the real, honest number —
  achieved by polling the live database repeatedly across this session (both natural
  conversation-turn latency and explicit wait periods), not by fabricating a longer window. See
  §11 for exactly how to extend this observation later using the same queries.

## Cycle counts (estimated from cron cadence, not from an invocation log — none exists)

- **Index cycles**: cron fires every 2 minutes → approximately **37** invocations in this window.
  Not independently countable (no per-invocation log table), but `chain_cursors.last_success_at`
  advanced continuously with `sync_state: idle` and `consecutive_failures: 0` throughout,
  consistent with every cycle succeeding.
- **Compare cycles**: cron fires every 15 minutes → **5 confirmed** directly from
  `indexer_shadow_reports` (2 rows per cycle — `deposits` + `claims` — so 10 total report rows,
  5 per scope), at `12:30:00`, `12:45:01`, `13:00:00`, `13:15:00`, and one earlier at `12:16`-ish
  covered by the prior checkpoint's report.

---

## Aggregate results (real data, `generated_at >= 2026-08-23 12:16:00`)

| Scope | Status | Count | Notes |
|---|---|---|---|
| `deposits` | `PASS` | 4 | `matched: 8` total across these 4 windows |
| `deposits` | `NOT_COMPARABLE` | 1 | the first, quiet window (already reported in the prior checkpoint) |
| `claims` | `NOT_APPLICABLE` | 5 | every cycle — correct, by design, unchanged |

**Classification totals across the whole window:**

| Metric | Total |
|---|---|
| RECEIVE_MATCH (`matched`) | **8** |
| TRUE_INDEXER_ONLY | **0** |
| WORKER_ONLY (raw) | **0** |
| ACCOUNTED_FOR_OTHER_ACTIVITY | **0** |
| TIMING_DIFFERENCE | **0** |
| NOT_COMPARABLE | **1** (the first window only) |

**Total chain events observed**: 2 new (`chain_events` ids 109, 110), both `status: confirmed`
(Arc's `confirmationDepth = 0` means nothing stays `pending` for any observable length of time —
`confirmed_at` was within 50ms of `created_at` for both). **Total pending events**: 0 sustained
(none observed in a pending state at any polling check). **Total reorged events**: 0
(`chain_cursors.reorg_count` stayed at 0 throughout).

**Duplicate events**: 0. Checked directly — `SELECT tx_hash, count(*) FROM chain_events GROUP BY
tx_hash HAVING count(*) > 1` returns zero rows across the entire table (all 110 historical rows,
not just this window).

**Indexer errors**: 0 (`chain_cursors.last_error IS NULL`, `consecutive_failures: 0`, sustained
across every poll).

**Activity-consumer errors**: not independently observable from this environment (no log
access to Edge Function runtime logs from these tools) — inferred healthy from the fact that
both new deposits were correctly represented in `activity` with no missing or malformed rows.

**Cursor errors**: 0 (`sync_state: idle` at every poll, `last_indexed_block` advancing).

---

## Critical live-event checks — results against real traffic

### 1. Normal USDC receive — ✅ VERIFIED on real, live data

Two genuine on-chain events occurred during this window and were traced end to end:

**Event A** — `chain_events` id `109`: `deposit_detected`, wallet `0xebe52519a3…fb784b`, native
USDC, `log_index: null` (correct — no log for a plain top-level transfer), `status: confirmed`.
Matched against an existing `activity` row (`recv_0x1da14d88…`, `activity_type: receive`,
`amount: 5.000000 USDC`, `metadata.fromUsername: "sunil.arc"` — an internal MeshPort-to-MeshPort
send). **Classification: RECEIVE_MATCH.** Confirmed in shadow report `id 2931` (`matched: 2`,
`workerOnly: 0`, `indexerOnly: 0`, `status: PASS`).

**Event B** — `chain_events` id `110`: `transfer_detected`, wallet `0x05d00ab7…64ee126e0`, EURC,
**`log_index: 59`, `contract_address: 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`** (the EURC
contract) — **the first real, live confirmation that the deployed scanner.ts is correctly
populating the new identity fields on genuine production traffic**, not just in tests. Matched
against `activity` row `recv_0xed2868e6…` (`activity_type: receive`, `amount: 0.881746 EURC`).
**Classification: RECEIVE_MATCH.**

Both traced end to end: **Blockchain Transfer → chain_events (confirmed, with correct identity
fields) → activity (receive)**, exactly the required chain, on real traffic, post-deploy.

### 2/3/4. Multiple Transfer logs in one tx / same recipient multiple transfers / swap multi-leg — ⚠️ STILL NOT OBSERVED ON LIVE DATA

**Directly checked across the entire `chain_events` table history (all 110 rows, not just this
window)**: `SELECT tx_hash, count(*) FROM chain_events GROUP BY tx_hash HAVING count(*) > 1`
returns **zero rows**. No multi-log transaction (BulkPay/Multicall3-shaped, a swap's two legs
both landing on the indexer's generic scan, or any other multi-event tx) has occurred in this
testnet's traffic at any point in this system's history, not just in this 75-minute window.

This remains verified only at the code/deploy level (source confirmed correct, `scanner.test.ts`
passes 10/10 including the dedicated regression tests for both scenarios), **not on live data**.
Extending the observation window further, however long, will not manufacture this traffic
pattern if it simply doesn't occur naturally on this testnet — this may need to remain a
code-level-only verification unless BulkPay/Swap volume increases, or Fix 2's coverage is
exercised by a future feature phase that specifically creates multi-log transactions.

### 5. Pending → confirmed transition — ⚠️ Not directly observed as a transition (Arc has effectively no pending window)

Both live events went `pending → confirmed` in under 50ms (`confirmationDepth = 0`), too fast to
catch mid-transition by polling. The **filter itself** is verified correctly in two ways: (a)
both events, once confirmed, correctly appeared in the comparison (proving the confirmed-only
filter doesn't accidentally exclude legitimate confirmed events — a real, if indirect,
confirmation of "confirmed → included"); (b) `compare.test.ts`'s dedicated `pending`/`reorged`
exclusion tests pass. A true "caught mid-pending" observation is structurally unlikely on Arc
given its zero confirmation depth — this would need a chain with nonzero depth to observe
directly, which none are currently enabled.

### 6. Reorg — not observed (correctly not manufactured)

Zero reorgs occurred (`reorg_count: 0` throughout, matching this system's entire history since
deployment on 2026-08-08). Per your explicit instruction, none was manufactured. This check
remains open until a natural reorg occurs — which, per Arc's documented finality model, may
never happen on this chain.

### 7. Duplicate scanner invocation — ✅ VERIFIED

No duplicate `chain_events` rows exist anywhere in the table (§ above). The cron fires every 2
minutes and necessarily re-scans overlapping ranges by design (`computeScanWindow` starts at
`last_indexed_block`, not `+1`) — the fact that 37-ish index cycles over 75 minutes produced
exactly 2 new rows (not more, not duplicated) is itself a live demonstration that the dedup
index is doing its job under real repeated-invocation conditions, not just in a controlled test.

---

## Individual incident detail

**Per your instruction to never hide incidents behind aggregates**: there were **zero**
TRUE_INDEXER_ONLY or WORKER_ONLY incidents in this window. The table below is intentionally
empty for that reason — this is not an omission.

| tx_hash | chain | block | event_type | log_index | classification | root_cause | financial_impact | resolution |
|---|---|---|---|---|---|---|---|---|
| *(none)* | — | — | — | — | — | — | — | — |

For completeness, the two events that *did* occur are logged here even though they were clean
matches, not incidents:

| tx_hash | chain | event_type | log_index | classification | note |
|---|---|---|---|---|---|
| `0x1da14d88ad1d4a7e674221a1ba1cdea1fbf84ab3067446b471021348f9e5435d` | arc | deposit_detected | null (native, no log) | RECEIVE_MATCH | Internal MeshPort send, 5 USDC |
| `0xed2868e6d034e65d2a0063816906dd2d69604102ce9a7a71a08fbf78c7492312` | arc | transfer_detected | 59 | RECEIVE_MATCH | EURC swap output, 0.881746 EURC |

---

## A real product observation, unrelated to Phase 3's own scope (disclosed, not fixed)

Tracing event `0xed2868e6…` surfaced something worth flagging even though it's **not caused by,
or fixed by, any Phase 3 change** (confirmed: no `activity` writer was touched in Phase 3 at
all). This transaction has **two separate `activity` rows**: a `swap` row (created `12:44:03`,
correctly showing `1 USDC → 0.881746 EURC`) and a `receive` row (created `12:44:01`, 2 seconds
*earlier*, `metadata.note: "External deposit (e.g. faucet)"`, `metadata.recovered: true`). This
exact note wording matches a mechanism traced in the prior forensic audit
(`docs/PHASE_3_REAL_STATE_AUDIT.md` §8, the `0xfc2ab12d…` case) that is **not**
`activity-consumer` (whose note strings are exactly `'External deposit'` or `'External deposit
(near a swap)'`) — this is some other, pre-existing recovery path, already active before Phase 3
began, that doesn't check for an existing `swap` row before crediting a plain `receive`. Net
effect: the user's Activity feed likely shows this one swap twice, under two different labels.
**This is a real, pre-existing product issue**, worth a dedicated look — but it predates Phase 3,
is not attributable to the deployed indexer/scanner/compare/monitor changes (which never write to
`activity`), and fixing it would mean touching an Activity writer, explicitly out of scope for
this checkpoint. Flagged here for visibility, not fixed here.

---

## Success criteria — status against this window's evidence

| Criterion | Status |
|---|---|
| Indexer remains healthy | ✅ zero errors, zero consecutive failures, sustained |
| Cursors continue advancing | ✅ `last_success_at` advancing every poll |
| No unexplained TRUE_INDEXER_ONLY | ✅ zero occurred (vacuously true — nothing to explain) |
| No unexplained WORKER_ONLY | ✅ zero occurred |
| No duplicate chain_events | ✅ verified directly, whole-table check |
| No Activity duplication attributable to the new indexer code | ✅ the one duplication found (above) predates Phase 3 and isn't caused by it |
| Confirmed filter behaves correctly | ✅ both live events correctly included once confirmed |
| Multi-log identity remains correct | ⚠️ **still code-level only** — no live multi-log transaction has ever occurred on this system |
| Comparison classification remains meaningful | ✅ both live events correctly resolved as RECEIVE_MATCH, no misclassification |
| No production errors introduced | ✅ zero |

**Overall**: every criterion that *could* be tested by the traffic that actually occurred, passed
cleanly. The one criterion genuinely unresolved is multi-log identity on live data — not because
anything is wrong, but because the triggering traffic pattern (BulkPay/Multicall3, or any
multi-recipient/multi-log transaction) has never once occurred on this testnet in this system's
entire recorded history, deploy or no deploy. That is a traffic-availability gap, not a code gap.

---

## Recommendation

**Phase 3 is not being marked complete in this report**, per your instructions. Two honest paths
forward, for you to decide between:

1. **Continue waiting for organic multi-log traffic** — re-run the queries in §11 periodically
   (hours/days) until a BulkPay, Multicall3, or multi-leg swap transaction naturally occurs, then
   verify it directly against real data the same way events 109/110 were traced above.
2. **Accept code-level verification as sufficient for this specific check** — given
   `scanner.test.ts`'s deterministic BulkPay-shaped and same-recipient-multi-transfer tests
   directly reproduce the exact scenario, pass, and were verified byte-for-byte deployed — and
   proceed on the understanding that this one check remains "verified in code, pending live
   confirmation whenever such traffic occurs" rather than "fully closed."

Both are legitimate; this report deliberately doesn't pick one, since that's a judgment call
about acceptable risk, not a technical question this data alone answers.

## §11 — Queries to extend this observation later

```sql
-- Aggregate classification totals since a given point in time
select scope, status, count(*) as windows,
  sum(matched) as receive_match,
  sum((details->>'trueIndexerOnly')::int) as true_indexer_only,
  sum(jsonb_array_length(details->'workerOnly')) as worker_only_raw,
  sum((details->>'accountedForOtherActivity')::int) as accounted_for_other_activity,
  sum((details->>'timingDifference')::int) as timing_difference
from indexer_shadow_reports
where generated_at >= '2026-08-23 13:31:12'
group by scope, status
order by scope, status;

-- Any multi-log transaction ever, across all history
select tx_hash, count(*), array_agg(log_index order by log_index)
from chain_events group by tx_hash having count(*) > 1;

-- Indexer health
select last_success_at, sync_state, consecutive_failures, last_error, reorg_count
from chain_cursors where chain_id = 'arc';
```

**Not proceeding to Phase 4. Not creating ledger_events. Not migrating Pay.** Stopping here,
per your instructions, for review.
