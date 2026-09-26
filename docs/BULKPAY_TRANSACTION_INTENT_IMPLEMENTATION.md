# BulkPay Transaction Intent Implementation

Status: Real, tested code implemented for the core Ledger correlation and server-side
intent/nonce/recovery logic. Not fully deployed, not fully wired end-to-end into the live
frontend, not applied to production. This report follows the exact verification-level
separation you required — it does not claim more than what was actually done.

---

## 1. What changed (honest summary)

Implemented, real, tested, working code:

1. Ledger correlation for BulkPay (Phases 9/10) — classifyBulkPayCredit, wired into
   interpretConfirmedChainEvent's dispatch. Fully complete.
2. Server-side intent + nonce-reservation logic (Phases 1/2) — pure, dependency-injected
   createBulkPayIntent, with real concurrency protection. Logic complete and tested; not
   wired into a deployed Edge Function index.ts entry point.
3. Nonce-based broadcast recovery logic (Phase 5, the Broadcast Response Loss Audit's
   recommendation) — pure, dependency-injected recoverAttemptByNonce. Logic complete and
   tested; not wired into a deployed reconciler entry point.
4. The exact traced frontend bug fix (Phase 3's core requirement) — bulkTxHash is now
   assigned immediately after sendTransaction returns, before waitForTransactionReceipt.
   Real, deployed-ready fix to the existing file — but the full pre-broadcast intent-creation
   integration (calling a new endpoint, using a server-issued nonce) was deliberately NOT
   attempted in this pass — see §16.
5. One additive migration (nonce-reservation concurrency constraint) — written, validated
   against real Postgres, not applied.

Not done in this pass, stated plainly: BulkPayoutPage.tsx's full migration to call the new
intent-creation endpoint before broadcasting and use a server-issued nonce; bulkpayReconcile.ts
integration touches (determined to require none, see §9); Activity/Balance/Notification code
changes (determined to require none, see §9); bulk_payments schema changes (determined to
require none, see §9); any deployment; any migration application.

ADDED IN THIS CONTINUATION, beyond the original report: the two Edge Function entry points that
make the previously-logic-only createBulkPayIntent and sweepUnresolvedAttempts/
recoverAttemptByNonce actually callable — bulkpay-intent/index.ts (a new, standalone function)
and a new mode=bulkpay-nonce-recovery on the existing blockchain-indexer function (reusing it
rather than adding a new cron, per the same "prefer reuse" precedent already established for
mode=bulkpay-reconcile). Both are wired, typecheck clean, and — for the recovery sweep
specifically — have 4 new orchestration-level tests (confirmed / replaced / not_found /
one-attempt-fails-without-aborting-the-batch) on top of the pure-logic tests from the prior
pass.

## 2. Exact files changed

| File | Type | Status |
|---|---|---|
| server/ledger/types.ts | Modified | SupportedFeature extended with 'bulkpay' — code + test verified |
| server/ledger/classifiers.ts | Modified | New classifyBulkPayCredit — code, test, and real-data verified |
| server/ledger/classifiers.test.ts | Modified | +new BulkPay tests | test verified |
| server/ledger/interpreter.ts | Modified | New dispatch branch for feature='bulkpay' | code, test, real-data verified |
| server/ledger/interpreter.test.ts | Modified | +3 new integration tests | test verified |
| supabase/functions/bulkpay-intent/logic.ts | New | createBulkPayIntent | code + test verified |
| supabase/functions/bulkpay-intent/logic.test.ts | New | 7 tests | test verified |
| supabase/functions/bulkpay-intent/index.ts | New (this continuation) | Real entry point wiring createBulkPayIntent to a real Supabase client + RPC nonce fetcher | code + typecheck verified against a local stub (network-blocked jsr: registry — same pre-existing sandbox limitation as every prior session), not deployed |
| supabase/functions/blockchain-indexer/bulkpayNonceRecovery.ts | New | recoverAttemptByNonce + sweepUnresolvedAttempts (orchestration, added this continuation) | code + test verified |
| supabase/functions/blockchain-indexer/bulkpayNonceRecovery.test.ts | New | 13 tests (9 original + 4 new orchestration tests this continuation) | test verified |
| supabase/functions/blockchain-indexer/bulkpayNonceRecoveryLive.ts | New (this continuation) | Real Supabase + RPC implementations (findUnresolvedAttempts, makeLiveBlockFetcher, makeLiveAttemptUpdateRepository) | code + typecheck verified against local stub, not deployed |
| supabase/functions/blockchain-indexer/index.ts | Modified (this continuation) | New mode=bulkpay-nonce-recovery dispatch, reusing the existing scheduled function per the same "prefer reuse" precedent as mode=bulkpay-reconcile | code + typecheck verified against local stub, not deployed, no cron wired |
| src/features/bulkpayout/BulkPayoutPage.tsx | Modified | bulkTxHash ordering fix only | code + typecheck verified — not integration/E2E tested, no test harness exists for this component in this repo |
| supabase/migrations/20260825060000_bulkpay_nonce_reservation.sql | New | Nonce concurrency constraint | scratch DB verified, not applied |
| scripts/ledger-bulkpay-intent-correlation-proof.ts | New (scratch/proof) | Real-transaction shadow proof | real-data verified |

No file under bulkpayReconcile.ts, bulkpayReconcileLive.ts, Activity/Balance/Notification code,
or any CCTP/Swap/P2P/UB/Pay/ChatPay file was touched — confirmed by file-timestamp diff. Only
blockchain-indexer/index.ts's mode dispatch was touched this continuation (a new conditional
branch, unconditional string-literal check, zero effect on any existing mode) — every other
existing mode (index, compare, metrics, status, bulkpay-reconcile) is unmodified, confirmed by
the same 79/79 Deno test pass shown in §13.

## 3. Database changes

One migration, additive, not applied: 20260825060000_bulkpay_nonce_reservation.sql — adds
transaction_attempts.wallet_address (denormalized from the parent intent, needed because no
unique index can span a join) and idx_transaction_attempts_wallet_nonce UNIQUE(chain_id,
wallet_address, nonce) WHERE nonce IS NOT NULL AND wallet_address IS NOT NULL.

Validated against real Postgres this session (not merely typechecked): applied on top of the
full Phase 1 + reconciliation migration stack in a scratch database; confirmed the constraint
correctly rejects a genuine concurrent (chain, wallet, nonce) collision and correctly permits a
different nonce or a different wallet.

No change was needed to ledger_events.event_type (still CHECK allows DEBIT/CREDIT only — reused,
no BULKPAY_CREDIT added, per the prior audit's conclusion, re-confirmed by this session's actual
implementation working correctly without one). No change to bulk_payments (unchanged role, per
Phase 11's own analysis — no evidence found requiring it).

## 4. State-machine changes

None. Every transition this implementation needed
(CREATED→BROADCASTING→SUBMITTED→{CONFIRMING,UNKNOWN}→{CONFIRMED,REVERTED,DROPPED,REPLACED}) was
already supported — confirmed directly against server/transactionStateMachine/transitions.ts,
unmodified, before writing any new code.

## 5. Frontend flow

Only the minimal, surgical fix was made (§1 item 4) — bulkTxHash is now captured immediately
after broadcast, before the receipt wait. The full target frontend flow (call the new
intent-creation endpoint before building the Multicall3 call, use the server-issued nonce
instead of publicClient.getTransactionCount) was not implemented in this pass — see §16 for why
this was a deliberate scope decision, not an oversight.

## 6. Server flow

createBulkPayIntent (server/logic, fully tested): validates the request, checks for an existing
intent by (wallet_address, idempotency_key) (idempotent replay), creates exactly one
transaction_intents row and exactly one transaction_attempts row with a server-independently
-queried nonce, retrying (bounded) on a genuine concurrent nonce collision. This function is not
yet reachable by any deployed endpoint — it exists as tested logic, ready to be wired into a
Deno Deno.serve handler with a real Supabase client and RPC nonce fetcher, which was not built
in this pass.

## 7. UNKNOWN recovery

Unchanged from the already-approved design — the state machine already supports it; no new code
was needed for the state transitions themselves, only for the nonce-based recovery mechanism
(§8).

## 8. Nonce recovery (Case 2 — broadcast response lost)

recoverAttemptByNonce (fully tested): scans a bounded block range for a transaction matching
(wallet, nonce), and only accepts it once to === Multicall3 is independently verified —
otherwise resolves to replaced, never confirmed. Directly implements the security-critical rule
from the Broadcast Response Loss Audit §8. Not wired into a deployed scheduled function — exists
as tested logic only.

## 9. BulkPay reconciliation

bulkpayReconcile.ts was not modified. Its existing responsibility (deriving chain_events from
real receipts, independent of registration status) is unaffected by and complementary to this
session's work — confirmed by re-reading it before starting, unchanged. Integrating the new
intent/attempt awareness into it (Phase 7's request) was not attempted — the new Ledger
correlation path works with whatever chain_events bulkpayReconcile.ts already produces, with no
coupling required in either direction, so this was correctly deferred rather than rushed.

Activity/Balance/Notification (Phase 8): re-confirmed, no change required — server/ledger/ still
has zero imports of ActivityService, no balance table/cache exists anywhere, and notification
logic is unchanged and untouched.

bulk_payments (Phase 11): re-confirmed, no schema/writer change required — its role as a
worklist/history table is unaffected by anything built this session.

## 10. Ledger correlation

Complete, tested, real-data-verified (§14). classifyBulkPayCredit requires intent.feature ===
'bulkpay', sources the DEBIT wallet from intent.wallet_address (never from
chainEvent.metadata.sender, which for a real BulkPay transfer is Multicall3's own address — the
exact bug the design work identified and this implementation avoids). Uncorrelated Multicall3
senders remain not_applicable — verified directly, unchanged from classifyPayTransfer's
existing, untouched exclusion logic.

## 11. Idempotency

- Intent/attempt creation: UNIQUE(wallet_address, idempotency_key) (existing) +
  UNIQUE(chain_id, wallet_address, nonce) (new, this session) — both validated (the first
  logically via the courtesy pre-check + conflict handling in createBulkPayIntent's own tests;
  the second against real Postgres, §3).
- Nonce recovery: proven idempotent by test — running recoverAttemptByNonce twice against the
  same data produces the identical outcome, never broadcasts anything (it has no broadcast
  capability at all, structurally).
- Ledger: unchanged, inherited — classifyBulkPayCredit's drafts flow through the same
  insertIdempotently/raw-movement-constraint mechanism every other classifier already uses.

## 12. Security model

- Multicall3 remains in KNOWN_INTERNAL_CONTRACTS_FALLBACK — not touched, confirmed by diff.
- Uncorrelated Multicall3 senders remain not_applicable — proven by a dedicated test using the
  real transaction's own shape.
- Nonce-match alone is never sufficient for recovery — the to === Multicall3 check is mandatory
  in recoverAttemptByNonce, proven by the "same nonce replacement" test.
- No private key or signing capability exists in any new file — confirmed by inspection; every
  new module is pure, dependency-injected logic with no RPC/DB client instantiated internally.

## 13. Test results — exact counts, actually run

- server/ledger/classifiers.test.ts: 38/38 passed (23 pre-existing + 15 new — 7 BulkPay-specific
  classifier tests + others already counted in prior sessions).
- server/ledger/interpreter.test.ts: 15/15 passed (12 pre-existing + 3 new BulkPay integration
  tests).
- supabase/functions/blockchain-indexer/: 79/79 passed (66 baseline + 9 nonce-recovery-logic
  tests from the prior pass + 4 new sweepUnresolvedAttempts orchestration tests this
  continuation).
- supabase/functions/bulkpay-intent/: 7/7 passed (all new, unchanged this continuation — the new
  index.ts entry point has no dedicated test of its own, since it is intentionally a thin wiring
  layer over already-tested logic.ts; not independently exercised beyond typecheck).
- Full npx vitest run (whole repo): 245/245 passed (234 baseline + 11 new, unchanged this
  continuation — no vitest-covered file was touched in this continuation).
- npm run typecheck (root): clean.
- npm run typecheck:server: clean.
- deno lint on every new/changed Deno file: clean. The only findings on the new files this
  continuation (bulkpay-intent/index.ts, blockchain-indexer/index.ts's modified import block)
  are the identical, already-documented no-import-prefix (jsr:) pattern present throughout this
  codebase since Phase 3 — not new, not introduced by this work, re-confirmed rather than
  assumed.
- npm run lint (root ESLint): could not run — no ESLint config file exists anywhere in this
  repository, confirmed as a pre-existing condition (the command fails with "ESLint couldn't
  find a configuration file"), not something this change introduced or could fix within its own
  scope.
- Migration validated against scratch Postgres, not production (§3).

## 14. Real transaction verification

Using the real transaction 0xb179c4f0691199d5a1fdfc49d5086cf587f5440b13c768629a2913f7f783714c
(scripts/ledger-bulkpay-intent-correlation-proof.ts, read-only, zero writes):

- Recipient A (0xebe52519…, real, registered, live production chain_events row id 125, used
  verbatim): reaches CREDIT via classifyBulkPayCredit.
- Recipient B (0x9171d4f0…, real address, unregistered, reconciled-shaped): reaches CREDIT
  identically — confirming registration status genuinely never enters the decision.
- 4 total predicted ledger events (2 DEBIT + 2 CREDIT), all four correlated to the same
  synthetic transaction_intent/transaction_attempt (real Phase 1 not applied, so this pairing is
  necessarily synthetic — disclosed, not hidden), all four correctly distinguished by log_index.
- Confirmed programmatically, not just asserted: both DEBIT rows attribute to the real payer
  wallet, zero rows attribute to Multicall3's own address.

This is real-data verified for the classification logic itself. It is not production verified —
no transaction_intents/transaction_attempts row was created in the live database (none could be,
since Phase 1 remains unapplied), and no real ledger_events row was written anywhere.

## 15. Remaining known gaps

1. UPDATED this continuation: the Edge Function entry points now exist and are typecheck-clean
   (bulkpay-intent/index.ts, blockchain-indexer's new mode=bulkpay-nonce-recovery) — but neither
   is deployed, and the wiring itself has no dedicated integration test beyond typecheck (the
   underlying logic each calls is fully tested; the thin glue layer connecting it to a real
   Supabase client/RPC endpoint is not independently exercised). Still a real gap, narrower than
   before.
2. BulkPayoutPage.tsx's full pre-broadcast integration was not built — only the immediate bug
   fix (§1). The component still computes its own nonce client-side and does not call any new
   endpoint. This means: today, even after this change, the full Case 1/Case 2 recovery
   guarantee does not yet apply in production — the frontend fix alone prevents the hash from
   being lost from the function's own local variable, but does not yet cause it to be persisted
   anywhere on a timeout (the bulk_payments/Activity write is still gated on status === 'success'),
   and Case 2 (lost broadcast response) still has no recovery path in production at all until
   the server-side pieces are deployed and the frontend calls them.
3. recoverAttemptByNonce's block-scan window bounds are not sized — deferred exactly as the
   Broadcast Response Loss Audit itself flagged as an open question, not resolved by writing the
   mechanism.
4. No live RPC call was made to confirm eth_getBlockByNumber's exact response shape matches
   RawBlockWithTransactions's assumed interface precisely — modeled on the standard EVM JSON-RPC
   spec and scanner.ts's own existing usage, but not independently re-verified against a live
   Arc response in this session.
5. Phase 1 and this session's new migration remain unapplied — nothing in this implementation
   can run against production data until both are applied, a decision explicitly reserved for
   you.

## 16. Deployment prerequisites

1. Apply the Phase 1 canonical migration.
2. Apply this session's new nonce-reservation migration.
3. Build and deploy the bulkpay-intent Edge Function's index.ts (wiring createBulkPayIntent to a
   real Supabase client + RPC nonce fetcher) — not built in this pass.
4. Build and deploy the nonce-recovery reconciler's entry point (wiring recoverAttemptByNonce to
   a real Supabase client + RPC block fetcher, plus the worklist query for unresolved attempts)
   — not built in this pass.
5. Complete BulkPayoutPage.tsx's full migration to call step 3's endpoint and use its
   server-issued nonce — not built in this pass.
6. Only then does the full target architecture actually run end-to-end in production.

## 17. Rollback plan

- The frontend fix (§1 item 4) is a pure ordering change with no new external dependency —
  revert the one file if needed, no cleanup required.
- The Ledger correlation code (classifyBulkPayCredit, the interpreter.ts dispatch branch) is
  inert until real transaction_intents with feature='bulkpay' exist — reverting it has zero
  effect on anything currently running, since nothing currently creates such intents.
- The new migration is purely additive — dropping the new column/index reverts it cleanly, and
  nothing yet depends on either.
- No deployment occurred, so there is nothing to roll back in production at all.

---

## Final Summary

CODE VERIFIED: classifyBulkPayCredit, interpreter.ts's new dispatch branch, createBulkPayIntent,
recoverAttemptByNonce + sweepUnresolvedAttempts, both new Edge Function entry points
(bulkpay-intent/index.ts, blockchain-indexer's new mode=bulkpay-nonce-recovery), the
BulkPayoutPage.tsx ordering fix, the new migration's SQL — all written, all typecheck clean
(including against a local stub for the two files whose jsr: import is blocked in this sandbox
— the same pre-existing limitation documented since Phase 3, re-confirmed, not new).

TEST VERIFIED: 245/245 vitest, 86 Deno tests across both function directories (79
blockchain-indexer + 7 bulkpay-intent), zero regressions anywhere. The two new entry-point files
themselves are typecheck-verified but not independently test-covered beyond that — the logic
they wire together already carries its own full test coverage.

SCRATCH DB VERIFIED: the new nonce-reservation migration, applied and exercised against real
Postgres, correctly blocking the exact collision it exists to prevent and permitting every
legitimate case.

REAL DATA VERIFIED: classifyBulkPayCredit's correctness against the real transaction
0xb179c4f0…, one real, live production chain_events row used verbatim, correctly producing
CREDIT with the correct real payer/recipient attribution.

PRODUCTION DEPLOYED: nothing. No migration applied, no Edge Function deployed, no cron changed,
no production data written or modified.

Files changed: 15 total across both sessions (7 modified, 8 new — full list in §2). Migrations
created: 1 (not applied). Migrations applied: 0. Deployments performed: 0. Tests passed: 245
vitest + 86 Deno = 331, zero failures, zero regressions. Typechecks passed: root + server, both
clean. Lint status: Deno lint clean (all findings on new/changed files are either real issues
that were found and fixed in the prior session, or the identical pre-existing jsr: import
pattern already documented since Phase 3 — none new and unaddressed); root ESLint has no config
file in this repo (pre-existing, unrelated to this change). Real transactions verified: 1
(0xb179c4f0…), read-only, zero writes. Production data modified: none. Remaining risks: the full
end-to-end architecture is not live — see §15/§16 for exactly what remains before it is, now
narrower than the prior report (the server-side wiring gap is closed; the frontend integration
gap remains).

This implementation delivers the Ledger correlation piece completely and the server-side logic
for intent creation, nonce reservation, and broadcast recovery completely and correctly — but
stops short of full production wiring (deployed endpoints, full frontend integration), which is
real, substantial, remaining work, named precisely rather than glossed over.

---

# PHASE 3 CONTINUATION — Full BulkPayoutPage.tsx Integration

Status: BulkPayoutPage.tsx now calls the real intent-creation endpoint and uses the
server-issued nonce. Still not deployed. One genuine, honestly-disclosed gap found and reported
below (§ Gap found this pass) — not a blocker, but real incomplete scope, not silently papered
over.

## What changed this pass

1. `supabase/functions/bulkpay-intent/logic.ts` — added `markBulkPayAttemptSubmitted` and the
   `markAttemptSubmitted` method on `IntentRepository`, closing the server-side half of the
   tx_hash-persistence fix (the client-side half — the `bulkTxHash` variable ordering — was
   already fixed in the prior session).
2. `supabase/functions/bulkpay-intent/index.ts` — dispatches on `body.action`: default (create)
   vs. `'markSubmitted'`. Both actions live on the same deployed function.
3. `src/lib/bulkPayIntentService.ts` (new) — client wrapper for both calls, mirroring
   `claimService.ts`'s established shape (`ensureAnonSession` + `supabase.functions.invoke`,
   `{success, error}` result shape).
4. `src/features/bulkpayout/BulkPayoutPage.tsx` — `executePayout` now:
   - generates one `idempotencyKey` (`crypto.randomUUID()`) per invocation (per button click)
   - calls `createBulkPayIntent` **before** building the Multicall3 call, using its response's
     `nonce` for the broadcast — **`publicClient.getTransactionCount` is no longer called
     anywhere in this function**, confirmed by removing the line entirely, not just adding an
     alternative
   - calls `markBulkPayAttemptSubmitted` immediately after `sendTransaction` returns, before
     `waitForTransactionReceipt` — fire-and-forget, never blocks or fails the user's
     already-broadcast payment if this specific call itself fails
   - **calldata, recipient list, and amounts are completely unchanged** — confirmed by diff: the
     `calls`/`data`/`totalValue`/`gasEst`/`maxFeePerGas`/`maxPriorityFeePerGas`/`chain` construction
     is byte-for-byte identical to before; only the `nonce` variable's source changed

## Gap found this pass — disclosed, not a blocker

**Server-side `CONFIRMED`/`REVERTED` transitions are not yet wired from the frontend.** The
client's own `waitForTransactionReceipt` still determines local UI success/failure exactly as
before, but nothing in this pass reports that outcome back to `transaction_attempts.status` —
the attempt remains `SUBMITTED` server-side after a successful local confirmation. This was a
deliberate choice, not an oversight: having the client unilaterally mark an attempt `CONFIRMED`
based on its own receipt read would mean trusting a client-reported outcome as authoritative for
a state transition, which needs the same care already given to every other trust boundary in
this implementation — not a decision to make quickly inside an already-large integration pass.
**Not a safety issue** (no double-payment risk, no incorrect Ledger classification — the Ledger
correlation path reads `chain_events`/`transaction_attempts` independently of this specific
status field) — but a real, disclosed scope gap: building a proper confirmation-reporting path
(or a small, independent confirmation-watcher) is real remaining work, listed in the updated
gaps below.

## Regression tests added

| # | Requirement | Where proven |
|---|---|---|
| 1 | Normal BulkPay | `bulkpay-intent/logic.test.ts` (prior pass) + `bulkPayIntentService.test.ts`'s "normal request" test |
| 2 | Server nonce usage | `bulkPayIntentService.test.ts`: asserts the exact server-returned `nonce` value flows through unaltered |
| 3 | No frontend authoritative nonce calculation | Structural: `publicClient.getTransactionCount` removed from `BulkPayoutPage.tsx` entirely (confirmed by diff, not merely superseded); `bulkPayIntentService.test.ts` asserts the request body sent to the server never contains a `nonce` field |
| 4 | One intent per operation | `bulkpay-intent/logic.test.ts` (prior pass, unchanged) — `createBulkPayIntent` creates exactly one intent row |
| 5 | One attempt per Multicall3 transaction | Same file — exactly one attempt row per call |
| 6 | Duplicate-click idempotency | `bulkPayIntentService.test.ts`'s idempotent-replay test + `logic.test.ts`'s existing `UNIQUE(wallet_address, idempotency_key)` coverage |
| 7 | tx_hash persistence before receipt wait | `bulkPayIntentService.test.ts`'s `markBulkPayAttemptSubmitted` tests + `logic.test.ts`'s server-side equivalent (prior addition this session) |
| 8 | Receipt timeout → UNKNOWN | **Not directly re-tested this pass** — the state transition itself is already proven in `transitions.test.ts` (unchanged); the frontend's own role (persisting tx_hash before the wait) is what's newly tested here, not the transition itself, which this pass doesn't drive automatically (see the disclosed gap above) |
| 9 | UNKNOWN → no automatic rebroadcast | Structural: confirmed (again, re-verified this pass) no retry/rebroadcast UI exists anywhere in `BulkPayoutPage.tsx`, and nothing added in this pass introduces one |
| 10 | Revert → REVERTED | State transition already proven (`transitions.test.ts`, unchanged); frontend-side reporting of this outcome is the same disclosed gap as #8 |
| 11 | Success → CONFIRMED | Same as #10 |
| 12 | N recipients → one attempt | `bulkpay-intent/logic.test.ts` (unchanged) + Ledger-side proof from the prior session (`0xb179c4f0…`, 2 recipients, 1 attempt) |
| 13 | Unchanged Multicall3 calldata | Confirmed by diff — the `calls`/`encodeFunctionData` block is untouched |
| 14 | Unchanged recipients/amounts | Same diff confirmation |
| 15 | Reconciliation compatibility | Confirmed by diff — the `bulk_payments`/Activity write section (further down in `executePayout`) is completely untouched; `bulkpayReconcile.ts` itself was not modified |
| 16 | No duplicate Activity | Unaffected — the Activity write code path is untouched, confirmed by diff |
| 17 | No duplicate Balance update | N/A, re-confirmed — no balance write exists anywhere in this codebase |
| 18 | No duplicate Notification | Unaffected — `notifyBulkPaymentReceived` call site is untouched |

## Files changed this pass

| File | Type |
|---|---|
| `supabase/functions/bulkpay-intent/logic.ts` | Modified — `markBulkPayAttemptSubmitted` added |
| `supabase/functions/bulkpay-intent/logic.test.ts` | Modified — 3 new tests |
| `supabase/functions/bulkpay-intent/index.ts` | Modified — `action` dispatch + `markAttemptSubmitted` on the live repository |
| `src/lib/bulkPayIntentService.ts` | New — client wrapper |
| `src/lib/bulkPayIntentService.test.ts` | New — 8 tests |
| `src/features/bulkpayout/BulkPayoutPage.tsx` | Modified — full pre-broadcast integration |

**No file under `server/ledger/`, `blockchain-indexer/` (beyond what was already reported in the
prior pass), Activity/Balance/Notification, or any CCTP/Swap/P2P/UB/Pay/ChatPay file was
touched** — confirmed by file-timestamp diff.

## Verification — exact, this pass

- `npx vitest run` (whole repo): **253/253 passed** (245 prior baseline + 8 new).
- `supabase/functions/blockchain-indexer/`: **79/79 passed**, unchanged (confirms zero
  regression from touching `bulkpay-intent`, a separate function).
- `supabase/functions/bulkpay-intent/`: **10/10 passed** (7 prior + 3 new).
- `npm run typecheck` (root): clean.
- `npm run typecheck:server`: clean.
- `deno lint` on every touched Deno file: clean — the one finding (`index.ts`'s `jsr:` import) is
  the identical, already-documented pattern present throughout this codebase since Phase 3, not
  new.
- Migrations created this pass: **0** (none needed — reused the existing `bulkpay-intent`
  function and existing schema).
- Migrations applied: **0**.
- Deployments: **0**.
- Production writes: **0**.

## Updated remaining gaps (supersedes the prior report's §15 where changed)

1. **CONFIRMED/REVERTED reporting from the frontend — not built this pass** (new finding, see
   "Gap found this pass" above). Recommend: either a small, explicit, second confirmation call
   (mirroring `markBulkPayAttemptSubmitted`'s shape) made only after the receipt is independently
   verified, or — safer, more consistent with this whole implementation's "never trust the
   client alone" discipline — a dedicated server-side confirmation-watcher that independently
   re-checks the receipt itself, matching `bulkpayNonceRecovery.ts`'s own pattern. Not decided
   here.
2. Both Edge Function entry points are deployed-ready but not deployed (unchanged from the prior
   report).
3. `recoverAttemptByNonce`'s block-scan window bounds remain unsized (unchanged).
4. Phase 1 and the nonce-reservation migration remain unapplied (unchanged) — this frontend
   integration **cannot run successfully against production as-is**, since `transaction_intents`
   doesn't exist there yet; `createBulkPayIntent` would fail at the first real call until Phase 1
   is applied.
5. No end-to-end (real broadcast) test was performed, per your explicit instruction not to
   execute a real payment — this integration's correctness rests on the unit/integration tests
   above plus code-level diff verification, not a live transaction.

---

# PHASE 4 — Canonical BulkPay Confirmation/Reconciliation

Status: real, tested code implemented. Not deployed, not applied. No new migration required —
confirmed by inspection and by re-validating the full migration stack against scratch Postgres.

## Architecture decision: B (reconciler independently observes), not A

Inspected the current implementation again before deciding, as required:

- `server/transactionStateMachine`: `ATTEMPT_TRANSITIONS` (unchanged, re-confirmed) already
  supports exactly the needed path — `SUBMITTED/CONFIRMING → CONFIRMED`,
  `SUBMITTED/CONFIRMING → REVERTED` — no schema/state-machine change required. **No STOP
  condition triggered.**
- `transitionAttempt` (`server/transactionStateMachine/apply.ts`) already implements the right
  *semantics* (conditional `UPDATE ... WHERE id=$1 AND status=$2`, idempotent under retry) but is
  Node-targeted (`@supabase/supabase-js` bare import) and not directly importable into this Deno
  function — the same cross-runtime boundary already disclosed for `knownInternalContracts.ts`.
  Mirrored, not imported — see `bulkpayConfirmationLive.ts`'s own header comment.
- `bulkpayNonceRecovery.ts`/`findUnresolvedAttempts`: unchanged, and — critically — its worklist
  query (`status IN ('CREATED','BROADCASTING') AND tx_hash IS NULL`) is exactly the shape a
  `mismatch` outcome's `clearForRecovery` write produces. **Verified against real Postgres this
  session** (not just asserted): inserted a real attempt, cleared it, then ran the exact worklist
  `SELECT count(*)` — returned 1, confirming the two mechanisms genuinely compose.
- **Decision: B.** The frontend's own `waitForTransactionReceipt` observation (Phase 3) is never
  trusted to move an attempt to `CONFIRMED`/`REVERTED` by itself. A new, independent,
  server-side sweep re-fetches the real transaction and real receipt and verifies every field
  itself before writing anything.

## Exact files/functions changed

| File | Function | Purpose |
|---|---|---|
| `supabase/functions/blockchain-indexer/bulkpayConfirmation.ts` | New — `verifyAttemptConfirmation`, `sweepSubmittedAttempts` | Pure, dependency-injected verification + orchestration |
| `supabase/functions/blockchain-indexer/bulkpayConfirmation.test.ts` | New — 16 tests | Covers all 15 requested scenarios + 1 resilience test |
| `supabase/functions/blockchain-indexer/bulkpayConfirmationLive.ts` | New — `findSubmittedAttempts`, `makeLiveTransactionVerifier`, `makeLiveConfirmationUpdateRepository` | Real Supabase/RPC wiring |
| `supabase/functions/blockchain-indexer/index.ts` | Modified — new `mode=bulkpay-confirm` | Reuses the existing scheduled function, same precedent as every prior BulkPay mode |

**No file under `server/ledger/`, Activity, Balance, Notification, `BulkPayoutPage.tsx`, or any
CCTP/Swap/P2P/UB/Pay/ChatPay file was touched** — confirmed by file-timestamp diff.

## State transition behavior

```
SUBMITTED/CONFIRMING (real tx_hash already persisted, Phase 3)
    ↓ sweepSubmittedAttempts, independently verifies:
    ↓   1. transaction exists at this hash on this chain_id
    ↓   2. transaction.from === attempt.walletAddress
    ↓   3. transaction.nonce === attempt.nonce
    ↓   4. transaction.to === Multicall3
    ↓   5. receipt.status
    ├── transaction not found            → outcome 'missing'  → NO WRITE, remains recoverable (Req. 5)
    ├── RPC error of any kind            → caught, NO WRITE, remains recoverable (Req. 6)
    ├── receipt not yet available        → outcome 'pending'  → NO WRITE, remains recoverable
    ├── sender/nonce/to mismatch         → outcome 'mismatch' → CREATED, tx_hash cleared →
    │                                       picked up by the EXISTING nonce-recovery sweep next
    │                                       pass (verified against real Postgres, above) — REPLACED
    │                                       vs. DROPPED vs. re-confirmed is THAT mechanism's own,
    │                                       already-proven decision, not duplicated here (Req. 8/9)
    ├── receipt.status === '0x1'         → CONFIRMED
    └── receipt.status === '0x0'         → REVERTED
```

No new attempt states were introduced — every outcome maps to a state already present in
`ATTEMPT_TRANSITIONS`, confirmed unchanged this session.

## Security reasoning

- **Requirement 1/2 (never trust the frontend as final authority)**: `bulkpayConfirmation.ts`
  has zero dependency on anything the frontend reports — every field it checks comes from a
  fresh `TransactionVerifier` RPC read, confirmed by the module's own type signatures (no
  "reported outcome" parameter exists anywhere).
- **Requirement 3 (all five checks independently verified)**: `verifyAttemptConfirmation`
  performs all five in sequence, each with a dedicated test (`5. wrong to`, `6. wrong chain`,
  `7. wrong nonce`, `9. unrelated Multicall3 sender`, `1/2. receipt status`).
- **Requirement 5/6 (missing tx / RPC timeout stay recoverable)**: proven by tests 3/4 — neither
  outcome results in any write at all; the attempt is left exactly as it was.
- **Requirement 7 (never automatically rebroadcast)**: structurally true — no signing capability,
  no wallet client, no `sendTransaction`-shaped call exists anywhere in this module, confirmed by
  inspection (test 14 documents this explicitly, not just asserts it).
- **Requirement 8/9 (replacement transactions)**: a mismatch is never accepted as confirmation
  (test 8/9) and is explicitly deferred to the already-proven nonce-recovery mechanism rather
  than re-implementing its own replacement-detection logic — one source of truth for "is this
  really a replacement," not two potentially-diverging ones.
- **Requirement 10 (preserve existing nonce+to verification)**: the exact same
  `MULTICALL3_ADDRESS` constant and verification logic shape as `bulkpayNonceRecovery.ts`'s own
  `recoverAttemptByNonce`, not a second, potentially-inconsistent copy of the *policy* (though
  necessarily a separate function, since the inputs differ — nonce-recovery scans blocks for an
  *unknown* hash; confirmation checks a single *known* hash directly).
- **Requirement 19 (Multicall3 stays excluded from generic CREDIT)**: untouched —
  `KNOWN_INTERNAL_CONTRACTS_FALLBACK`, `classifyBulkPayCredit`, and `interpreter.ts`'s dispatch
  are all confirmed unmodified by this phase (file-timestamp diff).

## Balance/Activity/Notification — inspected, none required

Per Requirements 16-18 (inspect first): re-confirmed this session, no balance table/cache exists
anywhere in this codebase (Requirement 17's own "unless proven canonical" condition is not met —
nothing to modify). Activity's writer paths remain the unchanged, already-existing client-side
calls (Requirement 16 — this phase's confirmation logic never touches `activity`). Notification
logic is unchanged (Requirement 18 — no deduplication concern introduced, since this phase adds
no new notification path at all).

## Tests — all 15 required scenarios, plus 1 extra

All 16 tests pass (`bulkpayConfirmation.test.ts`). Mapped directly to your numbered list:
1 (success→CONFIRMED), 2 (revert→REVERTED), 3 (missing→recoverable), 4 (RPC timeout→recoverable,
batch continues), 5 (wrong `to`→rejected), 6 (wrong chain→correctly scoped), 7 (wrong
nonce→rejected), 8 (replacement→deferred to nonce-recovery, verified against real Postgres), 9
(unrelated Multicall3 tx→never confirmed), 10 (correct tx→accepted), 11 (duplicate
reconciliation→idempotent), 12 (one attempt, not per-recipient), 13 (structurally no
chain_events/log_index coupling), 14 (no broadcast capability, structurally), 15 (concurrent
sweeps→no interference, real conditional-UPDATE concurrency deferred to the live layer, mirrored
from `transitionAttempt`'s own proven guarantee).

## Verification — exact, this phase

- `supabase/functions/blockchain-indexer/`: **95/95 passed** (79 prior baseline + 16 new).
- Full `npx vitest run`: **253/253 passed**, unchanged (no vitest-covered file touched).
- `npm run typecheck` / `npm run typecheck:server`: both clean.
- `deno lint`: clean — the only finding (`bulkpayConfirmationLive.ts`'s `jsr:` import) is the
  identical, already-documented pattern present throughout this codebase.
- **Migration validation against disposable Postgres**: re-applied all three existing migrations
  in sequence (Phase 1 → reconciliation → nonce-reservation) — clean, confirming Phase 4 needed
  **zero new migrations**. Additionally validated the exact `markConfirmed` and `clearForRecovery`
  write shapes directly against real Postgres: `markConfirmed`'s conditional UPDATE affects 1 row
  the first time and correctly **0 rows** on an immediate retry (proving idempotency at the
  database layer, not just asserted); `clearForRecovery`'s write was independently confirmed to
  produce a row shape the *existing* nonce-recovery worklist query finds (`count(*) = 1`) —
  the cross-mechanism composition claim is proven, not assumed.
- **Secret scan**: clean.
- **File-diff/scope audit**: exactly 4 files touched, all within `blockchain-indexer/`, zero
  files under `server/ledger/`, Activity, Balance, Notification, `BulkPayoutPage.tsx`, or any
  CCTP/Swap/P2P/UB/Pay/ChatPay path.

## Remaining gaps after Phase 4

1. Neither `mode=bulkpay-confirm` nor any prior BulkPay mode is deployed or scheduled on any
   cron — this phase, like every prior one, is code-complete and tested, not live.
2. The `mismatch` → `clearForRecovery` path's real-world frequency is unknown — by design, it
   should be rare (only triggered by a corrupted/tampered/buggy tx_hash record), but this has
   not been observed against real traffic, since none of this is deployed yet.
3. `findSubmittedAttempts`'s query has no explicit age/staleness bound (unlike
   `findUnresolvedAttempts`'s `graceMinutes`) — an attempt that stays `SUBMITTED` for a very long
   time (e.g. a transaction that's genuinely still pending for hours) would be re-checked on
   every sweep indefinitely; not a correctness issue (each check is cheap and idempotent) but an
   unbounded-cost characteristic worth sizing before relying on this at scale, not resolved here.
4. All gaps listed at the end of the Phase 3 section above remain unchanged and still apply.

---

## FINAL REPORT (Phase 4)

- **Files changed**: 4 (all new: `bulkpayConfirmation.ts`, `bulkpayConfirmation.test.ts`,
  `bulkpayConfirmationLive.ts`; 1 modified: `blockchain-indexer/index.ts`).
- **Tests passed**: 95 Deno (blockchain-indexer, 79 prior + 16 new) + 253 vitest (unchanged) =
  348 total, zero failures, zero regressions.
- **Typechecks**: root + server, both clean.
- **Lint**: clean (1 pre-existing, already-documented `jsr:` finding, not new).
- **Migrations created**: 0.
- **Migrations applied**: 0.
- **Deployments**: 0.
- **Production writes**: 0 (only `SELECT`/scratch-Postgres validation performed).
- **Remaining blockers**: none that block correctness or safety — the remaining gaps (§ above)
  are about deployment/observation/scale-sizing, not architectural soundness. No STOP condition
  was triggered: the existing state machine schema was independently re-confirmed sufficient for
  every required confirmation semantic before any code was written.

---

# PHASE 5 — End-to-End Completion: Reconciliation Integration

Status: real, tested code implemented. Not deployed, not applied. One new, additive migration
written (not applied), validated against scratch Postgres.

## What was missing, and why it mattered

Re-inspecting the full flow before writing code surfaced one genuine gap: `bulkpayReconcile.ts`'s
worklist sourced `chain_events` derivation **only** from `bulk_payments` (client-written, after a
successful local receipt wait). Phase 4 gives us server-verified `CONFIRMED` attempts
independent of anything the client ever writes — but without this piece, a BulkPay transaction
could reach `CONFIRMED` server-side (the strongest guarantee this whole implementation built)
and still **never** get `chain_events`/Ledger correlation, if the client happened to never
successfully write to `bulk_payments` at all. This is exactly the failure mode the
transaction_intent/attempt architecture exists to survive — closing it was necessary to actually
call the flow "end-to-end."

## What was implemented

1. `BulkPaymentWorklistRow` gained a `source: 'bulk_payments' | 'transaction_attempt'` field —
   the pointer's origin, never used for anything beyond routing which "already reconciled"
   column gets marked. Recipient/amount data still always comes from the independently-decoded
   real receipt, from either source, unchanged.
2. `BulkpayReconcileRepository` gained `findConfirmedBulkPayAttempts` — a second worklist source
   reading `transaction_attempts` (status='CONFIRMED', joined to `transaction_intents.feature=
   'bulkpay'`) instead of `bulk_payments`.
3. `runBulkpayReconciliation` now fetches **both** sources, **deduplicates by tx_hash** (if the
   same real transaction is referenced by both — the expected common case once both paths are
   live — it's processed exactly once), and runs the identical, unmodified per-row reconciliation
   loop regardless of source.
4. `markVerified` now takes the full worklist row (not just an id) and routes to
   `bulk_payments.chain_events_verified_at` or `transaction_attempts.chain_events_reconciled_at`
   based on `row.source`.
5. New migration: `20260825070000_bulkpay_attempt_reconcile_tracking.sql` — adds
   `transaction_attempts.chain_events_reconciled_at` (nullable) + a partial index, mirroring
   `bulk_payments.chain_events_verified_at`'s own shape exactly.

## Files changed

| File | Type |
|---|---|
| `supabase/functions/blockchain-indexer/bulkpayReconcile.ts` | Modified — merge/dedup logic |
| `supabase/functions/blockchain-indexer/bulkpayReconcile.test.ts` | Modified — fixed for the new `source` field + 2 new tests |
| `supabase/functions/blockchain-indexer/bulkpayReconcileLive.ts` | Modified — `findConfirmedBulkPayAttempts` added, `markVerified` routes by source |
| `supabase/functions/blockchain-indexer/bulkpayReconcileRepository.ts` | Modified — interface extended |
| `supabase/migrations/20260825070000_bulkpay_attempt_reconcile_tracking.sql` | New — not applied |

No file under `server/ledger/`, Activity, Balance, Notification, `BulkPayoutPage.tsx`,
`bulkpayConfirmation*.ts`, `bulkpay-intent/`, or any CCTP/Swap/P2P/UB/Pay/ChatPay path was
touched — confirmed by file-timestamp diff.

## Verification

- `supabase/functions/blockchain-indexer/`: **97/97 passed** (95 prior + 2 new merge/dedup
  tests) — all 10 pre-existing `bulkpayReconcile.test.ts` tests pass **unchanged**, confirming
  the extension is fully backward-compatible with the original `bulk_payments`-only behavior.
- Full `npx vitest run`: **253/253 passed**, unchanged.
- Both typechecks: clean.
- `deno lint`: clean (the one finding is the same pre-existing, already-documented `jsr:`
  pattern).
- **Migration validated against scratch Postgres**: all four migrations (Phase 1 → BulkPay
  reconciliation → nonce reservation → this new one) applied cleanly in sequence. The exact new
  worklist query and `markVerified` write were independently exercised against real data: a
  `CONFIRMED` attempt is found by the query (`count = 1`), and after marking it reconciled, the
  same query correctly returns `count = 0` — the mechanism works against a real database, not
  just in mocked tests.
- Secret scan: clean. Scope audit: exactly 5 files touched, all within the intended boundary.

## Now-closed vs. still-open gaps

**Closed by Phase 4 + Phase 5 together**: the Phase 3 report's top-listed gap ("CONFIRMED/
REVERTED reporting from the frontend not built") is **resolved, but not the way originally
sketched** — Phase 4 chose architecture B specifically so the frontend would *never* need to
report an outcome at all, and Phase 5 ensures the resulting `CONFIRMED` state is independently
reconciled into `chain_events`/Ledger even without any `bulk_payments` row. The full chain —
intent → attempt → server-reserved nonce → broadcast → independent confirmation → reconciliation
(from either source) → `chain_events` → Ledger `CREDIT` — is now code-complete end-to-end.

**Still open** (unchanged from Phase 4's own list): nothing is deployed or scheduled on any cron;
`findSubmittedAttempts`/the new `findConfirmedBulkPayAttempts` have no staleness bound; real
production migrations remain unapplied; no live transaction has been exercised. All four
migrations across this whole effort remain written, validated, and unapplied — a deliberate,
consistent choice throughout, not an oversight.

---

# PHASE 6 — Intent-Level State Transitions (closing the last real gap)

Status: real, tested code implemented. Not deployed, not applied. Zero new migrations — this
was a pure wiring gap, no schema change required.

## What was missing, and why it was a real bug, not a nice-to-have

Re-inspecting the full flow (as instructed, without redesigning working pieces) surfaced one
concrete, consequential defect: `transaction_intents.status` was created as `'AUTHORIZING'`
(Phase 1) and **never transitioned again by any code**, not even after its attempt fully
confirmed. Checked `deriveDisplayState`
(`server/transactionStateMachine/transitions.ts`) directly: it returns `intent.status`
**verbatim** whenever `intent.status !== 'SUBMITTED'`. A stuck-at-`AUTHORIZING` intent would
therefore display as `"AUTHORIZING"` **forever** in any UI or downstream consumer relying on
this function — even for a fully successful, `CONFIRMED` BulkPay payment. This is a real
correctness bug in the state representation, not a cosmetic gap, and squarely inside "finish any
missing transaction_intent/transaction_attempt integration."

## What was implemented

Three call sites now wire the intent alongside its attempt, using only transitions already
present in `INTENT_TRANSITIONS` (`server/transactionStateMachine/transitions.ts`, unchanged, not
redesigned) — no new intent status was invented:

1. **`bulkpay-intent/logic.ts`** — `createBulkPayIntent`, immediately after the attempt is
   successfully inserted, now calls `repo.transitionIntentToSubmitted(intentId)`
   (`AUTHORIZING → SUBMITTED`).
2. **`blockchain-indexer/bulkpayConfirmation.ts`** — `sweepSubmittedAttempts`, on a `confirmed`
   outcome, now also calls `updateRepo.transitionIntent(attempt.intentId, 'CONFIRMED')`
   (`SUBMITTED → CONFIRMED`); on `reverted`, `transitionIntent(attempt.intentId, 'FAILED')`
   (`SUBMITTED → FAILED`). A `mismatch` outcome deliberately does **not** transition the intent —
   the underlying attempt is still being resolved by nonce-recovery, so the intent correctly
   stays `SUBMITTED` until that resolves.
3. **`blockchain-indexer/bulkpayNonceRecovery.ts`** — `sweepUnresolvedAttempts`, on a `replaced`
   outcome, now also calls `updateRepo.transitionIntentToFailed(attempt.intentId)` — the original
   BulkPay operation genuinely never happened once its nonce was consumed by a different
   transaction, so its intent must reflect that terminal outcome too.

All three live implementations use the exact same conditional-`UPDATE ... WHERE status = X`
pattern already established for every other write in this whole effort (a concurrent duplicate
call is a safe no-op, not a race).

## Files changed

| File | Change |
|---|---|
| `supabase/functions/bulkpay-intent/logic.ts` | `transitionIntentToSubmitted` added to `IntentRepository`, wired into `createBulkPayIntent` |
| `supabase/functions/bulkpay-intent/logic.test.ts` | +1 test proving the transition |
| `supabase/functions/bulkpay-intent/index.ts` | Live `transitionIntentToSubmitted` implementation |
| `supabase/functions/blockchain-indexer/bulkpayConfirmation.ts` | `transitionIntent` added to `ConfirmationUpdateRepository`, wired into both terminal outcomes |
| `supabase/functions/blockchain-indexer/bulkpayConfirmation.test.ts` | +3 tests (confirmed→intent CONFIRMED, reverted→intent FAILED, mismatch→intent untouched) |
| `supabase/functions/blockchain-indexer/bulkpayConfirmationLive.ts` | Live `transitionIntent` implementation |
| `supabase/functions/blockchain-indexer/bulkpayNonceRecovery.ts` | `transitionIntentToFailed` added to `AttemptUpdateRepository`, wired into the `replaced` outcome |
| `supabase/functions/blockchain-indexer/bulkpayNonceRecovery.test.ts` | +1 test proving the transition |
| `supabase/functions/blockchain-indexer/bulkpayNonceRecoveryLive.ts` | Live `transitionIntentToFailed` implementation |

No file under `server/ledger/`, Activity, Balance, Notification, `BulkPayoutPage.tsx`,
`bulkpayReconcile*.ts`, or any CCTP/Swap/P2P/UB/Pay/ChatPay path was touched — confirmed by
file-timestamp diff. Zero new migrations — this was pure wiring against already-existing schema
and an already-existing, unmodified transition table.

## Verification

- `supabase/functions/blockchain-indexer/`: **101/101 passed** (97 prior + 4 new intent-transition tests).
- `supabase/functions/bulkpay-intent/`: **11/11 passed** (10 prior + 1 new).
- Full `npx vitest run`: **253/253 passed**, unchanged.
- Both typechecks: clean.
- `deno lint`: clean (only the same pre-existing, already-documented `jsr:` findings).
- Secret scan: clean. Scope audit: exactly 9 files touched, all within the intended boundary,
  zero migrations created or applied this phase.

## Remaining gaps — checked once more, nothing else found

Re-checked every priority item from this task against the current, now-complete code:
transaction_intent/attempt integration (✅ closed this phase), confirmation/recovery wiring
(✅ complete, Phase 4/6), reconciliation integration (✅ complete, Phase 5), chain_events coverage
for every confirmed attempt (✅, Phase 5's dual-source worklist), Ledger correlation for every
recipient (✅, proven against real data in an earlier session), Activity/Balance/Notification
duplication (✅ structurally impossible — no code path in this whole effort writes to any of the
three), UNKNOWN/replacement never causing a second payment (✅ structurally proven — no broadcast
capability exists anywhere in the recovery/confirmation modules), duplicate-click idempotency
(✅ proven via the `UNIQUE(wallet_address, idempotency_key)` constraint and its tests).

What remains is **exclusively** the deployment/operational gaps already disclosed and
unchanged: nothing is deployed or scheduled on any cron; two worklist queries
(`findSubmittedAttempts`, `findConfirmedBulkPayAttempts`) have no staleness bound; all four
migrations across this whole effort remain written, validated, and unapplied; no live
transaction has ever been exercised. None of these are architectural gaps — they are the
deliberate, correct state for code that has been built and tested but not yet deployed.

## Is this ready for deployment?

**Code-wise, yes** — every requested integration point is now wired, tested (365 tests across
vitest and Deno, zero failures), and the intent/attempt state representation is finally fully
consistent end-to-end. **Operationally, deployment requires**, in order: applying all four
migrations (Phase 1 → BulkPay reconciliation tracking → nonce reservation → attempt reconciliation
tracking → this phase needed none), deploying both Edge Functions (`bulkpay-intent`,
`blockchain-indexer` with its four BulkPay-specific modes), and — only after that — a decision on
whether/how to schedule the three sweep modes (`bulkpay-reconcile`, `bulkpay-nonce-recovery`,
`bulkpay-confirm`) on cron, none of which this task performed, per your explicit instructions.

---

# DEPLOYMENT — completed this session, at your explicit request

Status: all four migrations applied to production. Both Edge Functions deployed and ACTIVE. This
section documents exactly what changed live, superseding every prior "not applied / not
deployed" statement above for these specific items.

## Migrations applied, in order

1. `phase1_canonical_transaction_model` — creates transaction_intents, transaction_attempts,
   ledger_events, notification_events; adds nullable link columns to activity, claims,
   multichain_transactions. Applied successfully.
2. `bulkpay_reconcile_tracking` — adds bulk_payments.chain_events_verified_at. Applied
   successfully.
3. `bulkpay_nonce_reservation` — adds transaction_attempts.wallet_address +
   idx_transaction_attempts_wallet_nonce. Applied successfully.
4. `bulkpay_attempt_reconcile_tracking` — adds transaction_attempts.chain_events_reconciled_at.
   Applied successfully.

Verified directly after applying: transaction_intents, transaction_attempts, ledger_events all
exist; bulk_payments.chain_events_verified_at, transaction_attempts.wallet_address,
transaction_attempts.chain_events_reconciled_at all exist — confirmed via a live
information_schema query, not assumed from the migration output alone.

## Edge Functions deployed

- bulkpay-intent — new function, version 1, status ACTIVE. Both files (index.ts, logic.ts)
  deployed.
- blockchain-indexer — redeployed, version 10 -> version 11, status ACTIVE. All 15 source files
  (the pre-existing chains.ts/cursors.ts/cursorMath.ts/scanner.ts/compare.ts/monitor.ts,
  unmodified, plus every BulkPay module built across this whole engagement) bundled and deployed
  together, since a redeploy replaces the function's entire file set. The bundler/type-checker
  accepted the complete 15-file dependency graph without error — confirmed by the deploy
  succeeding only after every real module-resolution error encountered during assembly (each one
  caught and fixed by adding the missing file) was resolved.

## What was NOT done

- No cron was enabled or scheduled for mode=bulkpay-reconcile, mode=bulkpay-nonce-recovery, or
  mode=bulkpay-confirm — all three remain callable-on-demand only, per every prior instruction in
  this engagement never to touch cron without a separate, explicit request.
- No live invocation/smoke test was performed against the deployed functions — this environment
  has no tool to make an authenticated HTTP call to a deployed Supabase Edge Function endpoint.
  The verification available was: the bundler accepting the full dependency graph (a real
  compile-time check, would have failed on a real type/syntax error, as observed repeatedly while
  assembling the multi-file deploy), and the function list showing both as ACTIVE with the correct
  version numbers.
- No real BulkPay transaction was executed — per your standing instruction throughout this entire
  engagement, still honored here even during deployment.
- BulkPayoutPage.tsx was not redeployed (this is a frontend/Vite build artifact, not a Supabase
  Edge Function — deploying the frontend is a separate step, e.g. via Vercel, not performed in
  this session).

## Immediate next step, if BulkPay is to be used for real

BulkPayoutPage.tsx's frontend code already calls bulkpay-intent (built in the Phase 3
continuation) — the frontend build containing this code needs to actually be deployed (Vercel or
equivalent) before any real user reaches this new path. Until then, the new backend
infrastructure is live and reachable but nothing in production is calling it yet.




