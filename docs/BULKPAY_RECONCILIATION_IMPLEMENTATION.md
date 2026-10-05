# BulkPay Reconciliation Implementation

Status: **Implemented and verified. Not deployed, not applied to production.** Implements Option
B-refined from `docs/BULKPAY_INTENT_SCOPED_WATCH_DESIGN.md`, closing the exact gap traced in
`docs/BULKPAY_INDEXER_FORENSIC_AUDIT.md`.

---

## 1. What was implemented

A server-side BulkPay reconciliation path that independently re-fetches and decodes a real,
already-confirmed BulkPay transaction's receipt, and writes `chain_events` rows for every real
recipient found — regardless of whether that recipient is a registered MeshPort user.
Client-declared data (`bulk_payments`, `activity`, `bulk_payments_received`) is used only as a
pointer to which `tx_hash` to check — never as authorization for what gets written. Wired into
the existing `blockchain-indexer` function as a new, separately-callable mode
(`mode=bulkpay-reconcile`), not a new cron job.

## 2. Exact files changed

| File | Type | Purpose |
|---|---|---|
| `supabase/migrations/20260824090000_bulkpay_reconcile_tracking.sql` | New, not applied | Adds `bulk_payments.chain_events_verified_at` (nullable) + a partial index |
| `supabase/functions/blockchain-indexer/decodeTransferLog.ts` | New | Pure Transfer-log parsing, extracted from `scanner.ts` |
| `supabase/functions/blockchain-indexer/decodeTransferLog.test.ts` | New | 11 tests for the extraction |
| `supabase/functions/blockchain-indexer/scanner.ts` | Modified | Refactored to call the extracted decoder; 2 now-dead declarations (`MINT_FROM_TOPIC`, `topicToAddress`) removed |
| `supabase/functions/blockchain-indexer/bulkpayReconcile.ts` | New | Core decode + orchestration logic, pure/dependency-injected |
| `supabase/functions/blockchain-indexer/bulkpayReconcile.test.ts` | New | 10 tests — real transaction regression + all 10 requested security proofs |
| `supabase/functions/blockchain-indexer/bulkpayReconcileRepository.ts` | New | Repository/fetcher interfaces (the DB/RPC boundary) |
| `supabase/functions/blockchain-indexer/bulkpayReconcileLive.ts` | New | Real Supabase + RPC implementations of those interfaces |
| `supabase/functions/blockchain-indexer/index.ts` | Modified | Added `mode=bulkpay-reconcile` dispatch — no cron wiring changed |
| `scripts/ledger-bulkpay-reconciliation-proof.ts` | New | Read-only proof that a reconciled event flows through the unmodified Ledger Interpreter |

No file under `server/ledger/`, `src/`, `ActivityService.ts`, or any Pay/Swap/CCTP/P2P/UB file
was touched — confirmed by file-timestamp diff before writing this report.

## 3. Architecture

```
bulk_payments.tx_hash (pointer only, never trusted for recipient data)
    -> runBulkpayReconciliation (bulkpayReconcile.ts)
    -> ArcReceiptFetcher.getTransactionReceipt(tx_hash)   [real, independent RPC call]
    -> decodeBulkPayReceipt: verify receipt.to === Multicall3, verify status === success,
       decode every real Transfer log via decodeTransferLog.ts (the SAME logic the
       main scanner uses -- no duplicated parsing)
    -> chain_events rows written for every real recipient (BulkpayReconcileRepository.insertChainEvent,
       using the SAME chain_events_dedup_idx unique index the main scan already relies on)
    -> bulk_payments.chain_events_verified_at marked (idempotency)
    -> existing, unmodified Ledger Interpreter picks up the new chain_events row on its own,
       ordinary pass -- see §6 for what actually happens there
```

## 4. Security model

Directly implementing `docs/BULKPAY_INTENT_SCOPED_WATCH_DESIGN.md` §7's requirement — restated
against the actual code:

- `bulk_payments.tx_hash` is the only field ever read from a client-declared table by
  `bulkpayReconcile.ts` — confirmed by the function signatures themselves:
  `decodeBulkPayReceipt(worklistRow, receipt, ...)` uses `worklistRow.tx_hash` only to
  cross-check that the fetched `receipt` actually corresponds to it (defense against a caller
  bug, not a trust mechanism) — every recipient/amount/token field in the output comes from
  `receipt`, fetched independently.
- A fabricated `tx_hash` produces zero `chain_events` — proven by test 1: the real RPC call
  returns `null` for a transaction that never existed, and the reconciliation loop writes
  nothing.
- A fabricated recipient in `activity`/`bulk_payments_received` has zero influence — proven
  structurally (these tables are never read by this module at all) and by test 2/3, which
  decodes a real receipt and confirms a fabricated claimed address never appears in the output.
- A non-BulkPay transaction cannot become BulkPay events — proven by test 8: a real, confirmed
  transaction whose `receipt.to` isn't Multicall3 is rejected (`not_bulkpay`), never decoded.
- No address is ever added to `knownWallets` — confirmed by inspection: this module never
  imports or touches `loadKnownWallets`/`knownWallets` at all.

## 5. Idempotency model

Reuses the existing `chain_events` identity constraints (`chain_events_dedup_idx`, Phase 3) —
`bulkpayReconcileLive.ts`'s `insertChainEvent` is a plain insert that tolerates a `23505`
(duplicate key) error exactly like `cursors.ts`'s own `insertEvents` — no second identity system
was invented. `bulk_payments.chain_events_verified_at` provides reconciliation-level idempotency
— proven by test 6, re-running the same worklist row twice produces zero new rows.

Resilience, proven by test 10: one row's unexpected failure is caught per-row and does not abort
the batch — the failed row is left unverified (retried next pass) while every other row in the
same batch still completes.

## 6. Real transaction regression — and an honest limitation

Recipient A's log (`0xebe52519…`, `log_index: 6`, 10 USDC): used verbatim, taken directly from
the real `chain_events` row (id 125) already in production.

Recipient B's log (`0x9171d4f0…`, 14 USDC): could not be independently fetched. As disclosed in
`docs/BULKPAY_INDEXER_FORENSIC_AUDIT.md`, this environment has no RPC/explorer access to
historical Arc transactions. Recipient B's log in the test fixture is reconstructed from every
real, known fact (real wallet address, real amount from `activity`, real `tx_hash`, same
contract/block as recipient A's real log) with `log_index: 7` assumed adjacent to recipient A's
real `log_index: 6` — not independently verified. Stated here, in the test file's own header
comment, and in the prior session's forensic audit — not presented as fully-verified data
anywhere.

Result on this fixture: `decodeBulkPayReceipt` correctly produces 2 chain_events-shaped events,
one per recipient, neither depending on `users.wallet_address` in any way.

## 7. Test results (exact, actually run)

- `decodeTransferLog.test.ts`: 11/11 passed.
- `bulkpayReconcile.test.ts`: 10/10 passed — Phase 4 regression + all 10 Phase 5 security tests.
- `scanner.test.ts`: 10/10 passed, unchanged — confirms the `decodeTransferLog.ts` extraction is
  fully behavior-preserving, not just typechecked.
- Full `deno test .` (`blockchain-indexer/`): 66/66 passed (45 baseline + 10 + 11 new).
- Full `npx vitest run`: 234/234 passed, unchanged.
- `npm run typecheck` (root): clean.
- `npm run typecheck:server`: clean.
- `deno check` on every changed/new file: clean (the `jsr:`-import network-block limitation is
  the same pre-existing sandbox constraint documented since Phase 3 — re-verified against a
  local stub, confirming the code itself is correct).
- `deno lint` on every changed/new file: 5 findings remain, all pre-existing (1 `jsr:` import
  prefix in `index.ts`, matching `monitor.ts`/`cursors.ts`; 4 `no-explicit-any` in `scanner.ts`,
  already documented in `docs/PHASE_3_FIXES_APPLIED.md`). 2 genuinely new findings my own
  `scanner.ts` refactor introduced were found and fixed (dead `MINT_FROM_TOPIC`/`topicToAddress`
  removed). 10 more new findings in my own test file were found and fixed properly
  (unused-parameter/`require-await` issues from quick test mocks, corrected not suppressed).

## 8. Remaining limitations

1. Recipient B's exact log_index is reconstructed, not independently verified (§6).
2. A real, honest finding from Phase 8's own verification, not glossed over: running the
   reconciled `chain_events` shape through the existing, unmodified Ledger Interpreter
   (`scripts/ledger-bulkpay-reconciliation-proof.ts`) shows it does not currently reach `CREDIT`
   — because Multicall3's address (`0xca11bde0…`) is already present in
   `server/ledger/classifiers.ts`'s own `KNOWN_INTERNAL_CONTRACTS_FALLBACK` set (added during
   the earlier Ledger Core phase). The classifier correctly defers (`not_applicable`) exactly the
   same way it already does for Swap outputs. Verified this is specifically about the Multicall3
   sender, not registration status: re-running the identical event with a hypothetical
   non-Multicall3 sender correctly reaches `CREDIT` for the same unregistered wallet, with zero
   `users` table involvement either way. Conclusion: this reconciliation path successfully closes
   the `chain_events` coverage gap (§6), but full BulkPay Ledger classification still requires
   Phase 1 (`transaction_intents`, `feature='bulkpay'`) — the same blocker already documented
   for Swap in every prior Ledger validation pass. Not a defect in this implementation; a
   consequence of the Ledger's own, already-approved design being applied consistently.
3. `bulk_payments_received`, used only as a secondary cross-check target in the design doc, is
   not yet wired into an actual discrepancy-logging step — Phase 7 said this is optional, not
   implemented in this pass.
4. RPC cost sizing — not independently load-tested; the design doc's own risk section already
   flags this as worth confirming before relying on this path at volume.
5. No retroactive backfill — this implementation does not create a `chain_events` row for the
   already-missing `0xb179c4f0…` recipient B leg automatically; it would need one manual
   invocation of `mode=bulkpay-reconcile` after deployment.

## 9. Deployment steps (not performed — listed for your review)

1. Apply `supabase/migrations/20260824090000_bulkpay_reconcile_tracking.sql` (additive, already
   validated against real Postgres in this pass).
2. Deploy the updated `blockchain-indexer` function (every file in §2 under
   `supabase/functions/blockchain-indexer/`) — not performed here.
3. Verify `mode=bulkpay-reconcile` responds correctly against a real `bulk_payments` row,
   read-only inspection of the response before relying on it.
4. Do not wire a cron trigger for this mode without a separate, explicit decision — this
   implementation deliberately leaves that as a manual/on-demand callable mode.

## 10. Production rollout recommendation

Given §8 item 2's finding, recommend sequencing rollout as:

1. Deploy this reconciliation path first, on-demand only (no cron), and manually invoke it once
   to backfill the known real gap (`0xb179c4f0…`'s recipient B) — verifying end to end that a
   real `chain_events` row appears where none existed before.
2. Observe `chain_events` coverage for new BulkPay transactions over a period of real usage
   before deciding whether to wire a cron trigger.
3. Do not expect BulkPay transactions to produce Ledger `CREDIT` events yet, even once
   `chain_events` coverage is complete — §8 item 2 shows that requires the Ledger's own
   `transaction_intents` correlation (Phase 1), a separate, larger, already-tracked piece of
   work, not something this reconciliation path can or should short-circuit.

---

No production writes occurred. No migration applied, no deployment performed, no
`ledger_events`/Activity write, no `server/ledger/` file touched, no cron enabled or modified.
Stopping here per your instructions — not starting CCTP, not proceeding beyond proving the
resulting `chain_events`/Ledger flow.
