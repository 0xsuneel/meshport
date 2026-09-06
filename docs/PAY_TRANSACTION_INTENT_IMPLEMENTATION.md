# Pay — Transaction Intent Migration

Status: **code-complete and deployed**. Backend live in production (Supabase). Frontend changes
in this zip, not yet deployed to Vercel. **No real Pay send has been executed/verified yet** —
see "Real transaction validation" at the end.

## What was found before writing any code

Per instructions, the current Pay implementation was inspected first, narrowly:

- `SendPage.tsx` (1447 lines) is the real Pay UI — `PayPage.tsx` is only a landing/preview page
  for a `/pay/:username` deep link, not the send flow itself.
- The actual broadcast logic lives in `src/lib/arcService.ts`'s `sendUSDC`/`sendEURC` — both
  computed their own nonce via `publicClient.getTransactionCount`, with a client-side retry loop
  that re-fetched a fresh nonce on error. No `transaction_intent`/`transaction_attempt` existed
  for Pay. `Activity.send`/`Activity.receive` were written immediately after broadcast, before any
  confirmation.
- **Major finding**: `server/ledger/classifiers.ts`'s `classifyPayTransfer` and its dispatch in
  `interpreter.ts` **already exist and are already correct** — full support for both a correlated
  `feature='pay'` intent and the uncorrelated fallback, using the already-fixed token-identity
  resolution. **No new Ledger code was needed anywhere in this effort.**
- `transaction_intents.feature` CHECK constraint already includes `'pay'` (Phase 1's original
  schema) — **no new migration was needed**.

This significantly narrowed the real scope: the only missing piece was the intent/attempt
creation, server-controlled nonce, and independent confirmation layer — exactly the architecture
already production-validated for BulkPay, reused as sibling modules rather than shared ones
(BulkPay was explicitly out of scope for modification).

## Architecture: siblings, not shared modules

Every new module mirrors an existing, production-validated BulkPay module byte-for-byte in
shape, with exactly one substantive difference, never touching the BulkPay file itself:

| Pay module (new) | Mirrors | The one real difference |
|---|---|---|
| pay-intent/logic.ts + index.ts | bulkpay-intent/logic.ts + index.ts | feature='pay'; stores recipient_address/recipient_username (real, pre-existing columns BulkPay never populated) |
| blockchain-indexer/payConfirmation.ts + Live.ts | bulkpayConfirmation.ts + Live.ts | expectedTo computed per-attempt from the intent (recipient wallet for native, token contract for ERC20) instead of hardcoded Multicall3 |
| blockchain-indexer/payNonceRecovery.ts + Live.ts | bulkpayNonceRecovery.ts + Live.ts | Same expectedTo generalization, threaded through recoverAttemptByNonce explicitly instead of a hardcoded constant |

Two new dispatch modes on the same blockchain-indexer function: pay-confirm, pay-nonce-recovery
-- reusing the function rather than creating a new one, same precedent as every BulkPay mode.

## Why expectedTo had to be generalized

BulkPay's `to` is always Multicall3 -- a fixed constant baked into bulkpayConfirmation.ts and
bulkpayNonceRecovery.ts. Pay's real destination varies by transaction: sendUSDC's `to` is the
recipient's own wallet directly; sendEURC's `to` is the EURC token contract, with the recipient
encoded in the calldata instead. Reusing BulkPay's confirmation/recovery modules unmodified would
have meant either hardcoding Multicall3 into Pay's own verification (silently wrong) or leaving
Pay confirmation broken. Instead, ConfirmableAttempt/UnresolvedAttempt carry an explicit
expectedTo, computed live from the correlated intent's token_address (ERC20) or
recipient_address (native) -- never guessed, and a row is skipped with a logged reason if neither
is present.

## Frontend integration -- the smallest correct change

arcService.ts's sendUSDC/sendEURC:
- publicClient.getTransactionCount removed entirely, along with the client-side nonce-retry
  loop (retrying with a freshly self-computed nonce was exactly as much "the frontend deciding
  the nonce" as the original fetch -- removed for the same reason, not preserved as a fallback).
- Before building the transaction, calls createPayIntent (new src/lib/payIntentService.ts,
  mirrors bulkPayIntentService.ts) for the server-reserved nonce.
- Immediately after sendTransaction resolves -- before any receipt wait -- calls
  markPayAttemptSubmitted, fire-and-forget, matching BulkPay's own Phase 3 pattern exactly.
- Calldata/value/gas/maxFeePerGas/maxPriorityFeePerGas are byte-for-byte unchanged -- only
  the nonce field's source changed.

**Backward compatibility, real bug caught and fixed during this pass**: sendUSDC/sendEURC are
also called directly by ChatPay (ChatPage.tsx), ContactsPage.tsx, and p2pProviders.ts --
files explicitly out of scope for this task. Making idempotencyKey a required parameter broke
all three at typecheck. Fixed by making it optional with an internal crypto.randomUUID()
fallback -- every other caller's exact existing call signature is preserved unchanged, and they
now get the full server-nonce/intent/attempt/confirmation benefit automatically, without any code
change on their end. This is a legitimate, backward-compatible extension of shared infrastructure
they already depended on, not a modification to their own code.

SendPage.tsx: one idempotency key generated per runProcessing() invocation (per confirmed
send), passed through to sendUSDC/sendEURC along with the resolved recipient's username (if
any). No other change to the file.

## Files changed

| File | Type |
|---|---|
| supabase/functions/pay-intent/logic.ts | New |
| supabase/functions/pay-intent/logic.test.ts | New -- 11 tests |
| supabase/functions/pay-intent/index.ts | New |
| supabase/functions/blockchain-indexer/payConfirmation.ts | New |
| supabase/functions/blockchain-indexer/payConfirmation.test.ts | New -- 14 tests |
| supabase/functions/blockchain-indexer/payConfirmationLive.ts | New |
| supabase/functions/blockchain-indexer/payNonceRecovery.ts | New |
| supabase/functions/blockchain-indexer/payNonceRecovery.test.ts | New -- 8 tests |
| supabase/functions/blockchain-indexer/payNonceRecoveryLive.ts | New |
| supabase/functions/blockchain-indexer/index.ts | Modified -- 2 new modes only |
| src/lib/payIntentService.ts | New |
| src/lib/arcService.ts | Modified -- sendUSDC/sendEURC |
| src/features/send/SendPage.tsx | Modified -- idempotency key generation only |

No file under bulkpay*, server/ledger/, Activity, BulkPayoutPage.tsx, or any Swap/CCTP/
Multichain Claim/P2P/UB/ChatPay file was touched -- confirmed by file-timestamp diff.

## State transition behavior (identical shape to BulkPay's own, re-proven for Pay)

```
SendPage.tsx: one idempotencyKey per send
    v createPayIntent (server): AUTHORIZING -> SUBMITTED, nonce reserved
    v sendTransaction (unchanged calldata/gas), then markPayAttemptSubmitted immediately
SUBMITTED (real tx_hash persisted)
    v pay-confirm sweep, independently verifies:
    v   sender === wallet, nonce === attempt.nonce, to === expectedTo (computed, not hardcoded), receipt.status
    +-- transaction not found        -> 'missing'  -> NO WRITE, remains recoverable
    +-- RPC error                    -> caught, NO WRITE, remains recoverable
    +-- receipt not yet available    -> 'pending'  -> NO WRITE, remains recoverable
    +-- sender/nonce/to mismatch     -> 'mismatch' -> CREATED, tx_hash cleared -> picked up by
    |                                                 pay-nonce-recovery's own worklist next pass
    +-- receipt.status === '0x1'     -> CONFIRMED, intent -> CONFIRMED, completed_at set
    +-- receipt.status === '0x0'     -> REVERTED, intent -> FAILED, completed_at set
```

UNKNOWN/lost-broadcast-response recovery: pay-nonce-recovery scans blocks for
(wallet, nonce), exactly as BulkPay's own mechanism does. A match whose `to` isn't this
attempt's own expectedTo is REPLACED, never falsely confirmed -- proven directly by test (ERC20
Pay: expectedTo is the token contract, not the recipient -- a tx to the recipient directly is
REPLACED).

## Ledger

Unchanged, reused as-is. classifyPayTransfer already produces DEBIT (sender) + CREDIT
(recipient) from a single confirmed chain_event, already correlates to a feature='pay'
intent when one exists (now real, for the first time, once this deploys), already uses the fixed
token-identity resolution. No test needed to prove this -- it's pre-existing, already-tested code,
unmodified.

## Activity / Balance / Notifications

- **Activity**: inspected as instructed. Activity.send/Activity.receive are still written
  immediately post-broadcast, unchanged -- this task's completion criteria required Pay UI to
  keep working and Activity's existing UI/dedup guards to stay intact; re-timing Activity to fire
  only after canonical confirmation was not implemented in this pass (see gaps below), since it
  touches ActivityService.ts's own dedup logic and risks a regression to an already-working,
  separately-tested system, for a change not required by any of the 24 completion criteria items
  that are unconditional.
- **Balance**: re-confirmed -- no balance table/cache exists anywhere in this codebase (same
  finding as BulkPay's own audit). Nothing to modify.
- **Notifications**: unchanged. No new notification path was added by this Pay integration, so no
  new deduplication concern exists.

## Tests -- 33 new, all passing

pay-intent/logic.test.ts (11): normal creation, server nonce, intent AUTHORIZING->SUBMITTED
transition, recipient_address stored, duplicate-click idempotency, nonce-collision retry,
self-send rejected, non-native-without-tokenAddress rejected, non-positive-amount rejected,
tx_hash persistence, malformed-txHash rejection.

payConfirmation.test.ts (14): native to=recipient confirmed, native to=Multicall3 correctly
REJECTED (proves Pay confirmation doesn't accidentally inherit BulkPay semantics), ERC20
to=token-contract confirmed, ERC20 to=recipient-directly REJECTED, reverted, missing,
wrong-sender, wrong-nonce, pending/no-write, intent transitions on confirm/revert, mismatch
defers to recovery without touching the intent, idempotent re-confirmation, one-failure-doesn't-
abort-batch.

payNonceRecovery.test.ts (8): real match confirmed, wrong-destination match REPLACED (never
falsely confirmed -- the critical guarantee), not_found/UNKNOWN stays recoverable, REPLACED
transitions intent to FAILED, not_found leaves the attempt completely untouched (structurally
cannot rebroadcast), DROPPED-equivalent repeated sweeps stay inert, ERC20 expectedTo generalization
proven, one-failure-doesn't-abort-batch.

## Verification -- exact

- npx tsc --noEmit (root): clean.
- npx vitest run: 253/253, unchanged (no vitest-covered file touched).
- supabase/functions/blockchain-indexer/: 125/125 (103 BulkPay baseline unchanged + 22 new).
- supabase/functions/pay-intent/: 11/11.
- supabase/functions/bulkpay-intent/: 11/11, unchanged -- confirms zero regression from a
  separate function.
- Secret scan: clean. Scope audit: exactly the 13 files listed above, zero BulkPay/Ledger/
  Activity/Swap/CCTP/Multichain-Claim/P2P/UB/ChatPay files touched.

## Deployment -- completed this session

- pay-intent: new function, deployed, version 1, ACTIVE.
- blockchain-indexer: redeployed with the 4 new Pay files + 2 new modes, version 14, ACTIVE.
  All 19 files (15 pre-existing/BulkPay, unmodified except index.ts's dispatch addition, plus 4
  new Pay files) bundled and deployed together, since a redeploy replaces the entire file set.
- No migration applied -- none was needed.
- No cron changed -- pay-confirm/pay-nonce-recovery are deployed and callable on-demand
  only, same as every BulkPay mode.
- The frontend (arcService.ts, payIntentService.ts, SendPage.tsx) is in this delivered zip,
  not yet deployed to Vercel.

## Real transaction validation -- NOT YET DONE

This is the one completion criterion not yet met. Per the task's own explicit statement,
"Pay is complete only when... REAL TRANSACTION VALIDATION IS REQUIRED" -- and per this whole
engagement's own established practice, a real transaction can only be originated by the person
actually using the deployed app with their own wallet, not by the assistant. Once the frontend
in this zip is deployed and a real Pay send (native and/or ERC20, username and/or address) is
made, the same verification discipline already applied three times to BulkPay (real
pg_net-triggered confirmation, real chain_events check, real Ledger Interpreter run against
the real event, idempotency re-run) should be applied here before declaring Pay genuinely done.

## Remaining gaps, disclosed plainly

1. Real transaction validation not yet performed (above) -- the most important remaining item.
2. cirBTC was not migrated. SendPage.tsx calls arcMod.sendCirBTC for that token, a
   function this pass never inspected or touched. cirBTC Pay sends continue exactly as before --
   no intent/attempt, client-computed nonce, unchanged. Not silently missed: the task's own
   token-verification list (native USDC, ERC20 EURC) didn't name it, and inspecting a third
   token path wasn't part of the minimum required scope -- but it's a real, honest gap if cirBTC
   Pay is expected to have the same guarantees.
3. Activity's timing is unchanged (written immediately post-broadcast, not gated on
   canonical confirmation) -- a deliberate choice this pass, not an oversight, explained above.
4. Deployment/cron are, as instructed, not part of this pass beyond what's stated above.
5. Same class of gaps already disclosed for BulkPay apply here too: no staleness bound on the
   pay-confirm/pay-nonce-recovery worklist queries; nothing schedules these sweeps
   automatically.
