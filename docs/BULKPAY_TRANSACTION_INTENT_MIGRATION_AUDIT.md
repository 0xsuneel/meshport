# BulkPay Transaction Intent Migration Audit

Status: audit/design only. No code modified, no schema changed, no migration applied, no
deployment, no cron change, no server/ledger/Activity/Balance/Notification file touched, no
production data created or modified. Every claim below was verified against the current
repository and live database in this session — nothing is carried forward from prior audit
documents without re-verification. Anything not directly confirmed is marked UNVERIFIED.

---

## 1. Current Flow

Traced directly from src/features/bulkpayout/BulkPayoutPage.tsx (1228 lines, read in full for
this audit):

```
User builds recipient list (client-side React state only)
    -> executePayout() [line 261]
    -> restore wallet signer, check balance (client-side RPC read)
    -> build ONE Multicall3 aggregate3Value call, allowFailure: false for every leg
       (confirmed: the contract call itself is atomic -- all recipients paid or none, by
       Multicall3's own semantics, not an application-level guarantee)
    -> walletClient.sendTransaction(...) -> txHash obtained [line 343]
    -> publicClient.waitForTransactionReceipt({ timeout: 60_000, confirmations: 1 }) [line 355]
    -> IF this succeeds: bulkTxHash = txHash [line 358], txResults marked 'success'
    -> IF this throws (timeout, RPC error, revert): caught by the OUTER catch block [line 361],
       which only has access to `bulkTxHash` (still null -- the assignment at line 358 never
       ran) -- NOT the inner `const txHash` from line 343, which is block-scoped to the try
       that already failed. The real, already-broadcast tx_hash is lost from this code path
       entirely.
    -> only if txResults contains at least one 'success' entry: writes bulk_payments,
       bulk_payments_received (a VIEW over activity, not a base table), and activity rows
       (client-side, via ActivityService)
    -> notifyBulkPaymentReceived() -- LOCAL, client-side notification only (src/lib/
       notifications.ts) -- no server-side notification_events write exists
```

No transaction_intents/transaction_attempts row is created at any point -- confirmed by
repository-wide search (zero writers found, re-verified this session).

No application-level idempotency key exists anywhere in this file -- confirmed directly: the
only "nonce" referenced (line 336) is the raw Ethereum transaction nonce
(publicClient.getTransactionCount), not a persisted, app-level dedup key. The only
duplicate-click guard found is the client-side `processing` React boolean (line 135) --
in-memory only, lost on refresh, and not verified in this pass to actually disable the send
button (UNVERIFIED -- the state variable exists but its exact JSX consumption was not traced to
every call site).

## 2. Target Flow

```
BulkPayoutPage (client)
    -> BEFORE broadcast: call a NEW server-side function (does not exist today) that creates
       ONE transaction_intents row (feature='bulkpay', idempotency_key generated client-side,
       e.g. crypto.randomUUID(), wallet_address=payer, amount_atomic=total, metadata carries
       the N-recipient list -- see §3 Question B)
    -> server creates ONE transaction_attempts row (status='CREATED') tied to that intent
    -> client broadcasts the SAME Multicall3 transaction as today
    -> AS SOON AS a real tx_hash exists (before waiting for any receipt): the attempt is updated
       to status='SUBMITTED', tx_hash set -- this is the critical fix for the finding in §1: the
       tx_hash must be durably persisted the instant it's known, not only after a successful
       receipt wait
    -> receipt wait proceeds as today; success/failure/timeout updates the attempt's status
       (CONFIRMED/REVERTED/UNKNOWN) via the existing, already-built state machine
    -> indexer / bulkpayReconcile.ts (already implemented, prior session) independently derives
       N chain_events from the real, confirmed transaction -- unchanged by this migration
    -> Ledger Interpreter's interpretConfirmedChainEvent, for each of the N chain_events, calls
       findAttemptByTxHash(chain_id, tx_hash) -> finds the ONE transaction_attempt ->
       getIntent(attempt.intent_id) -> feature='bulkpay' -> N CREDIT ledger_events, each
       correlated to the SAME transaction_intent_id
```

## 3. Exact Files / Functions

| # | Question | Answer | Exact location |
|---|---|---|---|
| A | Where should transaction_intent be created? | A new server-side function -- cannot be a direct client insert. Confirmed live: transaction_intents/transaction_attempts have `REVOKE ALL ... FROM anon, authenticated` (migration file, line 312-313) -- the anon/authenticated roles that BulkPayoutPage.tsx's client-side supabase instance uses have zero access. Creation must happen through a new Edge Function or API route running with service-role credentials, called by the client before broadcasting. No such function exists today for BulkPay. | migration file lines 312-313 |
| B | What metadata? | Required: wallet_address (payer), feature='bulkpay', idempotency_key (client-generated, before broadcast), amount_atomic (total), decimals, token_symbol/is_native (native USDC, token_address stays NULL). Recommended: metadata.recipients (declared list, for cross-checking against the independently-decoded real recipients), metadata.purpose. Unnecessary: recipient_address/recipient_username (the schema's own singular fields) -- Pay-shaped, don't fit a fan-out; leave NULL. No new schema field needed. | transaction_intents column list |
| C | When should transaction_attempt be created? | Immediately after the intent (status='CREATED'), before broadcasting -- already fully supported by the existing state machine (ATTEMPT_TRANSITIONS: CREATED -> BROADCASTING -> SUBMITTED -> ...). No state machine change required. | server/transactionStateMachine/transitions.ts |
| — | Ledger correlation | repository.ts's findAttemptByTxHash(chainId, txHash) already has the exact signature needed -- confirmed unchanged. interpreter.ts's interpretConfirmedChainEvent already calls it. No repository change required. | server/ledger/repository.ts line 38 |
| — | Classifier | classifyPayTransfer explicitly rejects a correlated intent whose feature !== 'pay'. This proves a new classification path is genuinely necessary (see §8). | server/ledger/classifiers.ts |

## 4. Database Changes Required

| Item | Classification | Evidence |
|---|---|---|
| transaction_intents table | ALREADY EXISTS (still-unapplied Phase 1 migration) | supabase/migrations/20260823060000_...sql |
| transaction_attempts table | ALREADY EXISTS (same file, unapplied) | same |
| feature='bulkpay' as a valid value | ALREADY EXISTS in the CHECK constraint | confirmed directly, line 31 |
| ledger_events.event_type supporting BulkPay | ALREADY EXISTS -- reuses CREDIT/DEBIT, no new value needed (§8) | CHECK constraint, re-confirmed this session |
| A server-side intent-creation endpoint | REQUIRED -- new Edge Function/API route, not a schema change | §3.A |
| idx_transaction_intents_wallet_idem_key (dedup) | ALREADY EXISTS (UNIQUE (wallet_address, idempotency_key)) | migration file |
| idx_transaction_attempts_chain_txhash | ALREADY EXISTS | migration file |
| RLS on transaction_intents/transaction_attempts | ALREADY EXISTS (REVOKE ALL FROM anon, authenticated) -- service-role only | confirmed directly |
| RLS on bulk_payments | ALREADY EXISTS, and is a real finding: bulk_open policy, cmd: ALL, roles: {public}, qual: true, with_check: true -- completely open, any caller, any row -- confirmed live via pg_policies | see §10 |
| bulk_payments.chain_events_verified_at | ALREADY WRITTEN, NOT APPLIED (prior session's reconciliation migration) | supabase/migrations/20260824090000_bulkpay_reconcile_tracking.sql |
| A transaction_intents.metadata shape for BulkPay recipients | OPTIONAL -- metadata is already jsonb, no schema change needed | §3.B |
| Foreign key from bulk_payments to transaction_intents | NOT REQUIRED -- correlate by tx_hash alone, mirrors chain_events/transaction_attempts | design consistency |
| New ledger_events.event_type value (BULKPAY_CREDIT) | NOT REQUIRED | §8, re-confirmed against the live CHECK constraint text |

## 5. State Transitions

Using only states confirmed present in server/transactionStateMachine/types.ts this session --
none invented:

Intent: DRAFT -> REVIEWED -> AUTHORIZING -> SUBMITTED -> {CONFIRMED | FAILED}, or
{DRAFT,REVIEWED} -> CANCELLED/EXPIRED. For BulkPay: DRAFT/REVIEWED likely collapse (the user
reviews the recipient list in the existing UI before any server call is needed) -- not currently
decided, flagged as an open question in §17, not invented here.

Attempt: CREATED -> BROADCASTING -> SUBMITTED -> {CONFIRMING, UNKNOWN, REPLACED},
CONFIRMING -> {CONFIRMED, REVERTED, UNKNOWN}, UNKNOWN -> {CONFIRMED, REVERTED, DROPPED}. All
already supported, confirmed directly against ATTEMPT_TRANSITIONS, zero state machine changes
required for BulkPay specifically.

Ledger: PENDING -> POSTED -> {REVERSED}, REVERSED -> PENDING (the one documented exception,
unchanged, unrelated to BulkPay specifically).

## 6. Idempotency Design

- Intent creation: UNIQUE (wallet_address, idempotency_key) -- already exists. A duplicate
  button click that reuses the same client-generated idempotency_key is rejected at the
  database layer, not just the UI layer -- this is the answer to Question M, and it is the one
  piece of real, server-enforced protection currently entirely missing for BulkPay (today, only
  the client-side processing boolean exists, confirmed §1).
- chain_events: unchanged -- already idempotent via chain_events_dedup_idx (Phase 3), proven,
  not touched by this migration.
- ledger_events: unchanged -- already idempotent via ledger_events_event_key_key +
  ledger_events_raw_movement_key (prior sessions), proven, not touched.
- Reconciliation: unchanged -- already idempotent via bulk_payments.chain_events_verified_at
  (prior session, migration written not applied).

## 7. Failure / Recovery Design

### F. Broadcast fails (wallet rejection, user rejection, RPC failure, no tx_hash)

No transaction_attempt ever leaves CREATED/BROADCASTING. The intent should transition to FAILED
(a valid, already-supported transition from AUTHORIZING). No chain_events, no ledger_events --
nothing to reconcile, since nothing was ever broadcast.

### G. Receipt is reverted

Confirmed directly (§1): the Multicall3 call uses allowFailure: false for every leg -- a revert
means zero recipients were paid, atomically, by the contract's own semantics. Target:
transaction_attempt -> REVERTED, intent -> FAILED. No chain_events are ever created for a
reverted transaction (fundamental EVM behavior, confirmed in a prior forensic audit), and
bulkpayReconcile.ts's decodeBulkPayReceipt already checks receipt.status !== '0x1' and returns
{outcome: 'reverted'}, unchanged, already correct. No Activity, no Balance change, no Ledger
event.

### H. Receipt confirmation times out (the exact real gap found in §1)

This is the most important failure mode this audit found. The broadcast may have genuinely
succeeded even though the client's 60-second wait timed out. Target: the attempt transitions to
UNKNOWN (already-supported transition from SUBMITTED/CONFIRMING) -- critically, the tx_hash must
already be durably persisted by this point (per §2's "as soon as a real tx_hash exists"
ordering), unlike today's code, which loses it entirely on this exact path. The UI must show a
"pending, we'll confirm this" state, never a hard "failed."

### I. How UNKNOWN is reconciled

A reconciler (a natural extension of the already-built bulkpayReconcile.ts, or a small sibling
using the same ArcReceiptFetcher pattern) periodically scans transaction_attempts in UNKNOWN
status, re-fetches the real receipt by tx_hash (the attempt's own, already-persisted field --
never re-derived from client input), and finalizes: status='0x1' -> CONFIRMED (and proceeds to
produce chain_events/ledger_events normally); status='0x0' -> REVERTED; not found after the
configured lifetime window -> stays UNKNOWN, flagged for manual/alerting attention, never
silently abandoned.

CRITICAL, directly addressed: UNKNOWN must never cause a second broadcast. This is structurally
enforced by the target design, not just a UI convention: a new payment attempt requires a new
idempotency_key (client-generated fresh) -- reusing the same intent's idempotency_key to "retry"
would collide with the UNIQUE (wallet_address, idempotency_key) constraint and be rejected
server-side, even if the client-side UI state were somehow reset (e.g. a page refresh).

### N. Safe retry after UNKNOWN -- exact conceptual flow, confirmed against real transitions

```
UNKNOWN
  -> lookup existing attempt (by wallet_address -> most recent intent -> its attempt(s))
  -> attempt.status == 'CONFIRMED' -> show success, nothing more to do
  -> attempt.status == 'REVERTED' -> the ORIGINAL attempt failed; a genuinely NEW payment
     requires a NEW intent with a NEW idempotency_key (an explicit, deliberate user action)
  -> attempt.status == 'UNKNOWN' still -> show "still confirming," do not offer a retry button
     that would create a second broadcast; only the reconciler (§I) resolves this
```

## 8. Ledger Correlation Design

Does the existing repository already support this? Yes -- findAttemptByTxHash and getIntent are
both already exactly the right shape (§3). No server/ledger/repository.ts change is required.

Is classifyBulkPayCredit necessary? Proven, not assumed: classifyPayTransfer's current
DEBIT-construction logic derives the DEBIT wallet from chainEvent.metadata.sender -- for an
ordinary Pay transfer, this is genuinely the payer's own wallet. For a BulkPay recipient's
chain_events row, metadata.sender is Multicall3's own contract address, not the real payer --
confirmed directly against the real transaction traced in prior sessions (0xb179c4f0...'s
chain_events metadata: sender: '0xca11bde0...'). If classifyPayTransfer were naively widened to
accept feature='bulkpay', it would incorrectly attribute every DEBIT to Multicall3's own address
instead of the real payer -- a genuine correctness bug. This is the same DEBIT-sourcing
asymmetry already documented for Swap (types.ts's own header comment) -- the real payer's wallet
only exists on the correlated transaction_intent.wallet_address, never in the chain_event's own
metadata for this shape. A dedicated classification path is therefore necessary -- either a new
classifyBulkPayCredit function (mirroring classifySwapCredit's shape) plus a BulkPay-specific
DEBIT function (mirroring classifySwapDebit's shape: DEBIT sourced entirely from the confirmed
attempt+intent, never from any chain_event) -- not a widened classifyPayTransfer.

J/K/L -- the fan-out shape, concretely designed: one transaction_attempt correlates to N
chain_events (one per recipient, by tx_hash, exactly as findAttemptByTxHash already supports --
no new correlation primitive). Each recipient's CREDIT is sourced from its own chain_events row
(real wallet, real amount, real log_index -- the already-proven multi-log identity model, Phase
3). The payer's DEBIT side -- recommended design, not yet built: one DEBIT per recipient leg,
same payer wallet (from intent.wallet_address, not from the chain_event), same log_index as that
recipient's own CREDIT (giving each DEBIT/CREDIT pair the same raw-movement-identity treatment
already proven for ordinary Pay, and full per-leg auditability) -- rather than one aggregate
DEBIT for the whole batch. Both are representable under the existing raw-movement constraint
without any new identity concept; the per-recipient design was chosen in this audit's reasoning
for consistency with the already-proven multi-log model -- this specific choice is listed as an
open design decision in §17, not locked by this audit.

R -- registered vs. unregistered: unchanged conclusion from the prior Ledger validation work,
re-confirmed: neither classifySwapCredit nor classifyPayTransfer (nor any hypothetical
classifyBulkPayCredit built the same way) ever reads users.wallet_address -- the only gate is
intent correlation. Both registered and unregistered recipients reach the identical CREDIT
outcome once correlated, exactly as your target flow specifies.

## 9. Activity / Balance / Notification Consequences

- Activity (Question O): unchanged by this migration -- BulkPayoutPage.tsx's existing
  client-side Activity.bulk()/Activity.bulkReceived() calls continue exactly as today; this
  audit does not touch ActivityService.ts. Activity remains a projection, never a Ledger input
  (unchanged architectural boundary, re-confirmed: zero server/ledger/ imports of
  ActivityService).
- Balance (Question P): unchanged -- confirmed (again) that no balance table/cache exists
  anywhere in this codebase; balance is chain-derived via direct RPC read, unaffected by
  anything in transaction_intents/ledger_events.
- Notification (Question Q): unchanged -- notifyBulkPaymentReceived (src/lib/notifications.ts)
  remains a client-side, local notification, entirely independent of the server-side
  notification_events table (which, per Phase 1's own comment, has no writers for any feature
  yet -- not specific to BulkPay).

## 10. Security Analysis

- bulk_payments' RLS is a genuine, independently-discovered finding: bulk_open, cmd: ALL, roles:
  {public}, qual: true -- confirmed live. Any caller, authenticated or not, can insert, update,
  or delete any row in this table. This reinforces -- more strongly than previously documented --
  why bulk_payments/bulk_payments_received must never be treated as financial truth (already the
  design in bulkpayReconcile.ts, and unaffected by this specific finding, but worth flagging
  prominently since it's more severe than "merely client-written").
- Multicall3 stays in KNOWN_INTERNAL_CONTRACTS_FALLBACK -- per your explicit instruction, not
  revisited or challenged in this audit. The safe correlation requires all of: Multicall3 sender
  + a real, verified transaction_attempt + transaction_intent.feature='bulkpay' + matching
  chain_id + matching tx_hash. This prevents unrelated Multicall3 usage from being classified as
  MeshPort BulkPay because: (a) Multicall3 is a canonical, shared contract used by unrelated
  apps/users across the whole chain (prior audit's own finding, re-confirmed unchanged); (b)
  transaction_attempts.tx_hash is unique per chain (idx_transaction_attempts_chain_txhash), so a
  correlation can only ever succeed for the exact transaction MeshPort's own server created the
  intent/attempt for -- an unrelated third party's own Multicall3 call has a different tx_hash,
  which will simply never correlate, and therefore correctly remains not_applicable.
- Duplicate broadcast (client tampering): even a fully compromised or modified client cannot
  bypass the UNIQUE (wallet_address, idempotency_key) constraint, since intent creation happens
  server-side (§3.A) -- a tampered client could at most submit a new, distinct idempotency_key
  and cause a genuinely new, separate payment (indistinguishable from a legitimate new payment)
  -- this is a correct, expected limit of what idempotency alone can prevent, not a gap.

## 11. Migration Order

Derived from actual current state, not assumed:

1. Apply the already-written, still-unapplied Phase 1 migration
   (20260823060000_phase1_canonical_transaction_model.sql) -- prerequisite for everything else.
   Rollback point: purely additive (new tables only); revert by simply not using the new tables.
2. Apply the already-written, still-unapplied BulkPay reconciliation migration
   (20260824090000_bulkpay_reconcile_tracking.sql) -- independent of step 1, either order works;
   only adds a nullable column + index to bulk_payments. Rollback point: drop the column/index.
3. Build and deploy the new server-side intent-creation endpoint (§3.A) -- depends on step 1's
   tables existing. Rollback point: stop calling it from the client; nothing else reads
   transaction_intents yet.
4. Migrate BulkPayoutPage.tsx to call the new endpoint before broadcasting -- depends on step 3.
   Rollback point: revert this one file; steps 1-3 remain harmlessly unused.
5. Build the new Ledger classification path (§8) -- depends on step 1's tables having real data
   (step 4 must be live first). Rollback point: don't wire the new classifier into the dispatch;
   not_applicable behavior fully preserved.
6. Extend the UNKNOWN reconciler (§7.I) -- depends on step 3/4 producing real UNKNOWN attempts;
   can be built and tested independently of step 5. Rollback point: stop scheduling it; attempts
   simply stay UNKNOWN (a known, visible, alertable state, not silent data loss).

## 12. Rollback Strategy

- Disabling the new flow: revert BulkPayoutPage.tsx to its current form (step 4 above) -- the
  single point of integration between the old and new flows.
- Existing BulkPay remains safe: today's flow (direct bulk_payments write, no intent) does not
  depend on anything this migration adds.
- bulk_payments remains usable: unchanged table, unchanged writers, continues serving its
  current role regardless of migration progress.
- Coexistence: old-flow BulkPay transactions (no correlated intent) and new-flow ones
  (correlated) can coexist safely and indefinitely -- "no correlation found" is already a safe,
  well-defined outcome (not_applicable), not an error. A new-flow transaction is identified
  simply by whether findAttemptByTxHash succeeds for its tx_hash -- no separate flag needed.
- Duplicate broadcasts during rollback: since old-flow BulkPay never created an intent in the
  first place, rolling back to it doesn't change its (already-limited) duplicate-click
  protection -- rollback does not make anything less safe than it is today.

## 13. Test Plan

All 30 requested items, mapped to what they'd actually prove:

| # | Test | Proves |
|---|---|---|
| 1 | One recipient | Baseline N=1 fan-out (DEBIT+CREDIT pair) |
| 2 | Two recipients | Real transaction's own shape (0xb179c4f0...) |
| 3 | 10+ recipients | Fan-out scales, no N-dependent assumption breaks |
| 4 | Same tx_hash / different log_index | Multi-log identity re-proven at the Ledger layer |
| 5 | Same tx_hash / same log_index / different wallet | Structurally impossible -- defensive test |
| 6 | Retry same operation (same idempotency_key) | §6's server-enforced dedup |
| 7 | Duplicate button click | §6/§10 -- client-side state is not the only defense |
| 8 | Registered recipient | §8.R |
| 9 | Unregistered recipient | §8.R -- fully closed at the Ledger layer too |
| 10 | Mixed registered/unregistered | Both reach CREDIT identically |
| 11 | Genuine MeshPort Multicall3 BulkPay | The full happy path |
| 12 | Unrelated Multicall3 transaction | §10 -- correctly remains not_applicable |
| 13 | Multicall3 tx containing unrelated transfers alongside real BulkPay legs | Stress test of §10 |
| 14 | Wallet rejection | §7.F |
| 15 | Broadcast RPC failure | §7.F |
| 16 | Receipt timeout | §7.H -- the most important real gap found |
| 17 | UNKNOWN | §7.I |
| 18 | Confirmed after UNKNOWN | Reconciler resolving to CONFIRMED |
| 19 | Reverted after UNKNOWN | Reconciler resolving to REVERTED |
| 20 | Replaced | REPLACED transition, state-machine-supported, not yet exercised |
| 21 | Dropped | Same, for DROPPED |
| 22 | Reconciliation runs twice | Idempotency, re-proven with real intent correlation |
| 23 | Indexer runs before reconciliation | Ordering independence |
| 24 | Reconciliation runs before indexer | Same, reverse order |
| 25 | Missing chain_event | Correlated intent, no chain_events yet -> nothing, not a guess |
| 26 | Duplicate chain_event | Existing raw-movement constraint, re-proven for BulkPay |
| 27 | All N events correlate to ONE attempt | The core fan-out correlation claim |
| 28 | All N events become CREDIT | End-to-end classification outcome |
| 29 | Uncorrelated Multicall3 remains NOT_APPLICABLE | §9's regression baseline |
| 30 | Duplicate Ledger interpretation remains idempotent | Re-proven with the new path present |

## 14. Real Transaction Regression Plan

0xb179c4f0691199d5a1fdfc49d5086cf587f5440b13c768629a2913f7f783714c remains the target
regression fixture -- not modified or backfilled in this audit. Future implementation validation
should prove, using this exact transaction:

1. A real (or realistically reconstructed, per the same disclosed-limitation standard already
   used) transaction_attempts row exists for this tx_hash, correlated to ONE
   transaction_intents row with feature='bulkpay'.
2. Both recipients' chain_events rows, when run through the new classification path, each
   correlate to that SAME intent via findAttemptByTxHash.
3. Both produce CREDIT (not not_applicable), with the correct recipient wallet, correct amount,
   and (per §8's DEBIT design) a correctly-correlated DEBIT attributed to the real payer wallet
   (0x05d00ab7...), never to Multicall3's own address.
4. Re-running the classification a second time remains idempotent -- zero new rows.

No ledger_events were created for this transaction during this audit -- confirmed by
file-timestamp check before finishing this document.

## 15. Exact Implementation Phases

| Phase | Files | Functions | Schema | Tests | Dependencies | Rollback point |
|---|---|---|---|---|---|---|
| 1 | Phase 1 migration (apply, not modify) | -- | Applies Phase 1 as-is | Already validated, prior session | None | Revert application |
| 2 | New Edge Function (e.g. bulkpay-intent) | Create intent + attempt (CREATED), return intent_id | None (uses Phase 1 tables) | New -- intent creation, idempotency-key collision, RLS enforcement | Phase 1 applied | Stop deploying/calling it |
| 3 | BulkPayoutPage.tsx | Call the new endpoint before sendTransaction; persist tx_hash to the attempt instantly | None | New -- the exact §7.H timeout scenario, end to end | Phase 2 | Revert this one file |
| 4 | server/ledger/classifiers.ts, interpreter.ts | New classifyBulkPayCredit/classifyBulkPayDebit, wired into dispatch | None | New -- §13's full 30-item plan, adapted | Phase 1 applied, real BulkPay intents existing | Don't wire the new classifier in; not_applicable fully preserved |
| 5 | New reconciler (extends or sits beside bulkpayReconcile.ts) | Sweep UNKNOWN attempts, resolve via real receipt re-fetch | Possibly a small index (not yet designed) | New -- §7.I/§13 items 17-21 | Phase 2/3 producing real UNKNOWN attempts | Stop scheduling it; attempts stay UNKNOWN |

## 16. Risk Assessment

| Risk | Classification |
|---|---|
| Duplicate broadcast | Currently HIGH (no server-enforced protection exists); resolved to LOW by this design |
| UNKNOWN handling | Currently HIGH (§1/§7.H finding -- a real tx_hash can be silently lost today); resolved to LOW by persisting tx_hash before the receipt wait |
| Idempotency | LOW once implemented -- reuses proven, already-tested mechanisms |
| Multicall3 misclassification | LOW -- the tx_hash-correlation design structurally prevents it |
| Unregistered recipients | RESOLVED (prior sessions) at the chain_events layer; still open at the Ledger layer until this migration ships |
| Reconciliation race | LOW -- both already converge on the same chain_events_dedup_idx constraint |
| Activity duplication | Unaffected by this migration -- Activity is untouched |
| Balance duplication | N/A -- no balance write exists anywhere to duplicate |
| Notification duplication | Unaffected -- client-side notification logic untouched |
| Schema rollout | LOW -- both required migrations are purely additive, already written, already validated |
| Rollback | LOW -- every phase has a clean, non-destructive rollback point |
| Old/new flow coexistence | LOW -- correlated and uncorrelated BulkPay transactions coexist safely indefinitely |
| Client tampering | LOW for duplicate-broadcast purposes; bulk_payments' open RLS is a separate, real, higher-severity finding this migration doesn't fix -- worth a dedicated follow-up decision |
| RPC failure (intent-creation endpoint, receipt re-fetch) | MEDIUM, not fully designed -- retry/backoff policy for the new endpoint itself is not specified in this audit |

## 17. Open Questions / Unverified Findings

- UNVERIFIED: whether BulkPayoutPage.tsx's send button is actually disabled while
  processing === true -- the state variable exists; its exact JSX consumption was not traced to
  every call site in this pass.
- UNVERIFIED: bulk_payments' exact origin -- it is not defined in any migration file tracked in
  this repository, meaning it was created out-of-band. Its column list and RLS policy were
  confirmed via live introspection this session, but its history is not recoverable from the
  repository alone.
- Open design decision, not resolved by this audit: one DEBIT per recipient leg vs. one
  aggregate DEBIT for the whole intent (§8) -- both representable under the existing schema;
  this audit recommends the per-leg design for consistency, but does not lock it.
- Open design decision: whether DRAFT/REVIEWED intent states are meaningful for BulkPay given
  the existing UI's own review step, or whether BulkPay intents should be created directly in
  AUTHORIZING (§5) -- not resolved here.
- Not designed in this audit: the new intent-creation endpoint's own retry/backoff policy for
  its own RPC/DB calls -- flagged as a real, MEDIUM risk in §16, deferred to implementation.
- Not investigated in this audit: whether bulk_payments' open RLS policy (§10) is intentional, a
  known-and-accepted risk, or an oversight -- a genuine security question outside this audit's
  specific scope, surfaced because it was directly encountered, not chased further.

---

## Final Verification

1. Exactly one file created: docs/BULKPAY_TRANSACTION_INTENT_MIGRATION_AUDIT.md -- confirmed by
   file-timestamp diff before finishing.
2. Zero production source files changed -- confirmed.
3. Zero migrations applied -- confirmed (list_migrations shows no new entry).
4. Zero deployments occurred.
5. Zero cron jobs changed.
6. Zero server/ledger/ files changed -- confirmed.
7. Zero Activity/Balance/Notification files changed -- confirmed.
8. Zero production database rows created or modified -- confirmed (only SELECT queries were run
   against live data this session).
9. Every UNVERIFIED claim is marked explicitly in §17, not silently inferred.
10. Not proceeding to implementation. Stopping here for your review, per your instructions.
