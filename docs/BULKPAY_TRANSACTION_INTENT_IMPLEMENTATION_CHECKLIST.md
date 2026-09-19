# BulkPay Transaction Intent Implementation Checklist

Status: implementation-readiness audit only. No source file modified, no migration applied, no
deployment, no cron change, no server/ledger/Activity/Balance/Notification file touched, no
production data written. Every claim in this document was re-verified directly against current
repository files and live database state in this session — file mtimes were checked first to
confirm nothing changed since the prior audit, then the most load-bearing specific claims (the
bulkTxHash scoping bug, classifyPayTransfer's feature rejection, ATTEMPT_TRANSITIONS, live RLS
policies) were independently re-read/re-queried rather than trusted from the prior document.

---

## Refinement to the prior audit, found on closer implementation-level inspection

The prior audit recommended two separate functions (a classifySwapDebit-shaped BulkPay debit
function, plus a classifySwapCredit-shaped BulkPay credit function). Closer inspection of
interpreter.ts's actual dispatch shape shows this is not the right split. classifySwapDebit
needs only the attempt+intent (no chain_event) because Swap's debit leg is never independently
observable on-chain at all. BulkPay's debit leg is different: each recipient's DEBIT needs that
specific recipient's amount and log_index (to keep the same-payer-wallet,
different-log_index identity the multi-log model already relies on) — data that only exists on
that recipient's own chain_event, not on the attempt alone. This means BulkPay's DEBIT and
CREDIT actually need the same inputs as each other (the chain_event + the correlated
intent/attempt) — matching classifyPayTransfer's existing shape (one function, one chain_event
in, a DEBIT+CREDIT pair out via outcome.drafts, confirmed this exists already and supports
multiple drafts) far more closely than classifySwapCredit/classifySwapDebit's split shape.
Refined recommendation: one new function, classifyBulkPayCredit(chainEvent, correlated), returns
both drafts in one call — not two separate functions.

---

## 1-17. Areas re-audited, findings (delta from the prior pass only — full detail there)

| # | Area | Delta from prior audit | Verification method this session |
|---|---|---|---|
| 1 | BulkPayoutPage.tsx | None — re-read lines 309-311, 355-364 verbatim, byte-identical to prior findings (mtime unchanged since before the prior audit) | direct re-read |
| 2 | BulkPay helpers/services | None found beyond BulkPayoutPage.tsx itself — confirmed again, no separate service file exists | repo search |
| 3 | bulk_payments | RLS re-confirmed live: bulk_open, cmd: ALL, roles: {public}, qual: true — unchanged | live pg_policies query |
| 4 | transaction_intents | Schema unchanged (migration file mtime predates this session); still does not exist live | file re-read |
| 5 | transaction_attempts | Same | same |
| 6 | server/transactionStateMachine | ATTEMPT_TRANSITIONS re-confirmed verbatim, unchanged | direct re-read |
| 7 | server/ledger/types.ts | ClassificationOutcome's drafts: LedgerEventDraft[] (plural, array) re-confirmed — this is what makes the refined single-function design directly implementable with zero type changes | direct re-read |
| 8 | server/ledger/repository.ts | findAttemptByTxHash/getIntent signatures unchanged | direct re-read |
| 9 | server/ledger/classifiers.ts | classifyPayTransfer's feature rejection re-confirmed at the exact line | direct re-read |
| 10 | server/ledger/interpreter.ts | New finding this session: interpretConfirmedChainEvent's dispatch has no 'bulkpay' branch at all — confirmed by direct re-read, not previously quoted this precisely | direct re-read |
| 11 | blockchain-indexer | Unchanged — KNOWN_INTERNAL_CONTRACTS/Multicall3 exclusion untouched, not re-audited beyond confirming it's untouched | file mtime check |
| 12 | bulkpayReconcile | Unchanged — confirmed still produces chain_events only, never touches ledger_events/transaction_intents | file mtime check + repo search |
| 13 | Activity writers | Unchanged — ActivityService.ts not imported anywhere under server/ledger/ | repo search |
| 14 | Balance writers | Unchanged — still zero balance table/cache anywhere | repo search |
| 15 | Notification writers | Unchanged — notifyBulkPaymentReceived remains client-side only | file re-read |
| 16 | Supabase RLS | chain_events re-queried live for comparison: chain_events_select (public, SELECT only) + chain_events_service_all (service_role, ALL) — a cleaner pattern than bulk_payments' open policy | live query, new this session |
| 17 | Current tests | Zero tests reference bulkpay/Multicall3 anywhere under server/ | repo search |

---

## Exact Implementation Checklist

| # | File | Function/Component | Current behavior | Required new behavior | Why required | Dependency | Migration prerequisite | Test required | Rollback consideration |
|---|---|---|---|---|---|---|---|---|---|
| 1 | New Edge Function (name TBD) | e.g. createBulkPayIntent | Does not exist | Server-side only (service-role), creates 1 transaction_intents row (feature='bulkpay') + 1 transaction_attempts row (status='CREATED'), given (wallet_address, idempotency_key, amount_atomic, recipients metadata) | transaction_intents/transaction_attempts are REVOKE ALL FROM anon, authenticated — no client-side insert is possible (Question A) | Phase 1 migration applied | Phase 1 (20260823060000_...sql) | Idempotency-key collision returns existing intent, not a new one; RLS rejects a direct client attempt | Stop calling it; nothing else depends on its output yet |
| 2 | src/features/bulkpayout/BulkPayoutPage.tsx | executePayout | No pre-broadcast server call; bulkTxHash stays null on any post-broadcast error (Question E) | Call #1 before building the Multicall3 call; on sendTransaction returning a real txHash (line 343 today), immediately call a second, small update (Question D) persisting it to the attempt (status='SUBMITTED') before waitForTransactionReceipt runs | Closes the exact, currently-real tx_hash-loss bug traced in the prior audit and re-confirmed this session at the exact same lines | #1 deployed | Phase 1 | The exact timeout scenario, end to end, using a mocked slow/failing waitForTransactionReceipt | Revert this one file; #1 remains harmlessly unused |
| 3 | Same function | Receipt success/failure/timeout handling (lines 355-364 today) | Loses txHash on any error path (the bug) | On success: attempt -> CONFIRMED. On revert (receipt.status === 'reverted', already checked at line 356): attempt -> REVERTED. On timeout/other error: attempt -> UNKNOWN (never FAILED — a real broadcast happened) | Matches the state machine's own already-supported transitions exactly, no new states needed | #2 | Phase 1 | Failure scenario items 4-6 specifically | Same as #2 |
| 4 | server/ledger/classifiers.ts | New classifyBulkPayCredit | Does not exist | Given (chainEvent, correlated: {intent, attempt}) where intent.feature === 'bulkpay': returns {outcome: 'classified', drafts: [DEBIT(wallet=intent.wallet_address, ...), CREDIT(wallet=chainEvent.wallet_address, ...)]} — both legs share chain_id/tx_hash/log_index, differ only on wallet_address, mirroring classifyPayTransfer's existing DEBIT/CREDIT pairing shape exactly, except the DEBIT wallet comes from intent.wallet_address, never chainEvent.metadata.sender (see refinement above, and Question S) | classifyPayTransfer cannot safely be reused as-is (proven, not assumed — its DEBIT sourcing would misattribute to Multicall3's own address) | #1-3 producing real intents | Phase 1 | Full 30-item plan from the prior audit, re-scoped to this one function's actual signature | Simply don't call it; classifyPayTransfer's existing not_applicable behavior for uncorrelated Multicall3 senders is completely unaffected |
| 5 | server/ledger/interpreter.ts | interpretConfirmedChainEvent's dispatch (confirmed today has no 'bulkpay' branch) | correlated && intent.feature === 'swap' ? classifySwapCredit(...) : classifyPayTransfer(...) | Add a third branch: correlated && intent.feature === 'bulkpay' ? classifyBulkPayCredit(...) : ... (Swap and BulkPay both checked before the classifyPayTransfer fallback) | This is the exact, single integration point that currently silently routes every BulkPay-correlated event to classifyPayTransfer's rejection | #4 | Phase 1 | A dedicated dispatch test: a feature='bulkpay' correlation reaches classifyBulkPayCredit, never classifyPayTransfer | Revert this one conditional; zero effect on Pay/Swap dispatch |
| 6 | New reconciler (extends bulkpayReconcile.ts or a sibling) | e.g. reconcileUnknownBulkPayAttempts | Does not exist — today's bulkpayReconcile.ts only ever processes bulk_payments rows, never transaction_attempts | Sweep transaction_attempts WHERE status='UNKNOWN' AND chain_id='arc', re-fetch the real receipt by the attempt's own already-persisted tx_hash (reusing ArcReceiptFetcher, already built), finalize to CONFIRMED/REVERTED | UNKNOWN-reconciliation requirement | #2/#3 producing real UNKNOWN rows | Phase 1 | Failure scenario items 4-6, 8-12 | Stop scheduling it; attempts remain UNKNOWN (visible, alertable — not silent loss, since #2/#3 already persisted the tx_hash durably) |

---

## Answers (A-S), verified against current code

**A. Exact location where transaction_intent should be created.** A new server-side Edge
Function (checklist item #1) — confirmed there is no existing function this could be added to
without creating a mixed-concern deploy. Called from BulkPayoutPage.tsx before any Multicall3
call is built.

**B. Exact idempotency key source and database uniqueness protection.** Source: a fresh
crypto.randomUUID() (or equivalent) generated client-side, once, at the moment the user confirms
the payout. Protection: transaction_intents_wallet_idem_key UNIQUE (wallet_address,
idempotency_key) — already exists in the Phase 1 migration, confirmed unchanged this session.

**C. Exact location where transaction_attempt should be created.** The same new Edge Function
(#1), immediately after the intent row.

**D. Exact moment tx_hash must be persisted.** Immediately after walletClient.sendTransaction
returns (line 343 today) — before the line 355 waitForTransactionReceipt call. This is the
single most important ordering change this whole migration makes.

**E. What happens if broadcast returns tx_hash but receipt waiting times out.** Per checklist
item #3: the attempt transitions to UNKNOWN, not FAILED — the tx_hash is already durably
persisted (per D), so nothing is lost, unlike today's actual behavior.

**F. How UNKNOWN is reconciled server-side.** Checklist item #6 — a periodic sweep of
transaction_attempts in UNKNOWN status, using the attempt's own persisted tx_hash to
independently re-fetch the real receipt.

**G. How a user safely retries UNKNOWN without creating a second payment.** The UI must not
offer a "retry" action that builds a new Multicall3 call — only the reconciler (F) resolves
UNKNOWN. A genuinely new payment requires a genuinely new idempotency_key (B).

**H. How reverted transactions are represented.** Attempt -> REVERTED. No chain_events, no
ledger_events — reverted transactions emit zero logs (fundamental EVM behavior) and
bulkpayReconcile.ts's own decodeBulkPayReceipt already returns {outcome: 'reverted'} for this
case, unchanged, already correct.

**I. How replaced/dropped transactions are represented, if supported.** REPLACED and DROPPED are
both already valid, already-supported attempt states — confirmed directly against
ATTEMPT_TRANSITIONS this session. Not currently exercised by any BulkPay-specific code — a gap
in what's implemented, not in what the state machine supports.

**J. How one transaction_attempt maps to N recipient chain_events.** By (chain_id, tx_hash) —
findAttemptByTxHash is called independently for each of the N chain_events rows; all N calls
resolve to the same one attempt, since they share the same tx_hash. No batching or N:1
aggregation logic needs to be built.

**K. How log_index remains the per-recipient identity.** Unchanged — each recipient's
chain_events row already carries its own real log_index (Phase 3's identity model, already
proven for BulkPay via the real 0xb179c4f0... transaction). The new BulkPay DEBIT reuses the
same log_index as its paired CREDIT, giving each pair its own distinct raw-movement identity.

**L. How registered and unregistered recipients are treated identically by Ledger.**
classifyBulkPayCredit, like every existing classifier, never reads users.wallet_address. Both
recipient types reach CREDIT identically once correlated; the ONLY gate is intent correlation.

**M. How existing bulkpayReconcile fits into the new architecture.** Unchanged in its own
current responsibility (deriving chain_events from real receipts). The new UNKNOWN-reconciler
(#6) is a separate, new piece of code operating on a different table for a different purpose —
they can run independently, in either order, without interfering.

**N. Whether bulk_payments remains as a compatibility/projection/worklist table.** Yes —
unchanged role. Nothing in this migration requires removing or restructuring it.

**O. Exact point where Activity should be generated.** Unchanged — BulkPayoutPage.tsx's existing
Activity.bulk()/Activity.bulkReceived() calls, untouched by this migration.

**P. Exact point where Balance should update.** N/A, unchanged — no balance table/cache exists
anywhere; balance remains chain-derived via direct RPC read.

**Q. Exact point where Notifications should fire and how deduplication works.** Unchanged —
notifyBulkPaymentReceived fires exactly where it does today. Server-side notification_events has
no writer for any feature, BulkPay included, and building one is out of scope here.

**R. Whether a dedicated classifyBulkPayCredit is actually required.** Yes, proven again this
session, more precisely than before: classifyPayTransfer's DEBIT sourcing
(chainEvent.metadata.sender) would attribute every BulkPay DEBIT to Multicall3's own address,
not the real payer — confirmed by direct re-read of the classifier code and the real transaction
evidence (0xb179c4f0...'s chain_events.metadata.sender = 0xca11bde0...).

**S. Exact evidence required before converting a Multicall3-originated event to CREDIT.**

```
sender == Multicall3 (KNOWN_INTERNAL_CONTRACTS_FALLBACK, unchanged, not removed)
  AND chain_id matches
  AND tx_hash matches a real transaction_attempts row (findAttemptByTxHash — already built)
  AND that attempt's transaction_intent.feature == 'bulkpay' (getIntent — already built)
  => classifyBulkPayCredit produces DEBIT+CREDIT
  ELSE => classifyPayTransfer's existing known-internal-contract exclusion applies
     => not_applicable, exactly as today
```

A random, unrelated Multicall3 transaction has a tx_hash that will never correlate to any
MeshPort-created transaction_attempts row — it therefore always falls to not_applicable,
structurally, not by convention.

---

## Failure Scenarios (all 16), traced against current + target behavior

| # | Scenario | Current behavior (verified) | Target behavior |
|---|---|---|---|
| 1 | User clicks BulkPay twice | Only the client-side processing boolean guards this (UNVERIFIED whether wired to the button's disabled prop) — no server-side protection exists | Fresh idempotency_key per action, or UNIQUE constraint rejects a reused one server-side |
| 2 | First request creates intent, second arrives concurrently | N/A — no intent exists today | UNIQUE constraint resolves the race at the DB layer |
| 3 | Broadcast succeeds but frontend loses response | No trace anywhere | Partially solved — see STOP CONDITIONS, one genuine open gap remains if the frontend never receives the RPC response at all |
| 4 | Broadcast succeeds but receipt times out | The exact traced bug — tx_hash lost entirely | Attempt -> UNKNOWN, tx_hash already persisted |
| 5 | Receipt later confirms | Not reconciled at all today | Reconciler finds the real receipt, attempt -> CONFIRMED |
| 6 | Receipt later reverts | Same | Reconciler -> REVERTED |
| 7 | User closes the app after broadcast | Same as #3/#4 | Same as #4/#5 — server-side persistence makes this recoverable |
| 8 | Server reconciliation runs while UI is still waiting | N/A today | Safe — independent, whichever resolves first is authoritative |
| 9 | Indexer sees events before reconciliation | Already proven safe (prior session) | Unchanged |
| 10 | Reconciliation sees events before indexer | Same | Unchanged |
| 11 | Reconciliation runs twice | Already proven idempotent | Unchanged |
| 12 | Ledger interpreter runs twice | Already proven idempotent generally | Re-proven with classifyBulkPayCredit present — same mechanism |
| 13 | One batch has 2 recipients | The real, traced transaction's own shape | Fully covered |
| 14 | One batch has 100 recipients | Untested at this scale | No N-dependent assumption found; not independently load-tested — a test gap, not a design gap |
| 15 | One recipient registered, one unregistered | Already proven at the chain_events layer | Proven at the Ledger layer by this design |
| 16 | Unrelated Multicall3 transaction pays a MeshPort wallet | Currently not_applicable (safe, accidental) | Remains not_applicable, now by design |

---

## IMPLEMENTATION ORDER

Derived from the dependency column of the checklist above, not assumed:

1. Apply the Phase 1 migration (20260823060000_...sql) — every other item depends on
   transaction_intents/transaction_attempts existing.
2. Build and deploy the intent-creation endpoint (checklist #1).
3. Migrate BulkPayoutPage.tsx's pre-broadcast call (checklist #2).
4. Migrate BulkPayoutPage.tsx's post-broadcast persistence ordering (checklist #3, the core bug
   fix).
5. Build classifyBulkPayCredit (checklist #4) — depends on step 1 only, can be built and fully
   unit-tested with synthetic fixtures before steps 2-4 are live.
6. Wire the new dispatch branch in interpreter.ts (checklist #5).
7. Build the UNKNOWN reconciler (checklist #6) — depends on steps 2-4 producing real UNKNOWN
   attempts; can be developed independently of steps 5-6.
8. Real transaction regression validation (per the prior audit's plan).
9. Production observation — a period of real BulkPay traffic before treating any of this as
   fully proven.

Note: steps 5-6 (the Ledger classification path) do not depend on steps 2-4 being live — they
only require step 1 (schema) and can proceed in parallel with the BulkPayoutPage-side work.

---

## STOP CONDITIONS

- No required schema is unavailable — transaction_intents/transaction_attempts are fully
  designed and validated, only unapplied.
- No state-machine mismatch found — every transition BulkPay needs is already supported,
  confirmed twice now.
- RLS is correctly restrictive for the new tables, but bulk_payments' own RLS is a real,
  independent problem (bulk_open, fully public ALL) — not a blocker for this specific migration
  (the new architecture never trusts bulk_payments as authoritative), but flagged again as a
  standalone security issue worth a separate decision, re-confirmed live this session.
- No missing server-side transaction lookup — findAttemptByTxHash/getIntent already exist.
- tx_hash CAN be persisted immediately — confirmed via sendTransaction's own return value being
  available well before the receipt wait.
- UNKNOWN reconciliation is buildable — ArcReceiptFetcher/rpcCallRace already exist.
- Multicall3 correlation is safe by design, not merely by current accident.
- Activity/BulkPay client data is correctly never treated as authoritative in this design.
- One genuine, unresolved gap: scenario #3/#7 (frontend never receives the broadcast response at
  all) is not fully solved by this design if the persistence call itself depends on the frontend
  surviving long enough to make it. Whether this is an acceptable residual risk or needs a
  different mitigation (e.g. persisting before signing, with a subsequent confirmation step) is
  not resolved in this audit — flagged as the one genuine open design question, not blocking the
  rest of the implementation.

No blocker prevents proceeding with implementation once explicitly approved, aside from the one
flagged residual gap above, which should be a conscious decision, not a silent gap.

---

## Final Verification

- Exactly one documentation file changed: docs/BULKPAY_TRANSACTION_INTENT_IMPLEMENTATION_CHECKLIST.md.
- Zero production code changes.
- Zero migrations applied.
- Zero deployments.
- Zero cron changes.
- Zero server/ledger/ source changes.
- Zero Activity/Balance/Notification source changes.
- Zero production database writes (only SELECT/pg_policies reads were run this session).

Not starting implementation. Stopping here for your explicit approval, per your instructions.
