# BulkPay Broadcast Response Loss Audit

Status: audit only. No code modified, no schema changed, no migration, no deployment, no
Ledger/Activity/Balance/Notification file touched, no production data written. Every claim
below verified against current repository code this session.

---

## 1. Current Broadcast Flow

Traced directly from src/features/bulkpayout/BulkPayoutPage.tsx:

```
nonce = publicClient.getTransactionCount(wallet, 'pending')   [client-side RPC read, line 336]
txHash = walletClient.sendTransaction({ ..., nonce })          [line 343]
  -- txHash is now known to the CLIENT PROCESS'S JS heap only. Nothing is persisted
     anywhere (server or otherwise) at this exact instant.
receipt = publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 }) [line 355]
```

Nonce is computed client-side, not server-issued — confirmed directly (line 336): the client
calls getTransactionCount itself; the server has no independent record of which nonce was
intended for this specific attempt until/unless a future design persists it (see §9).

## 2. Failure Window

The exact window this audit is about: between sendTransaction's underlying RPC call actually
succeeding on the wallet/RPC provider's side (the transaction is genuinely broadcast, and may
even be mined) and the JavaScript await on line 343 actually resolving in the client's own
process. If the tab closes, the browser is killed, or the network connection is lost in that
window, the client's own local txHash variable is never assigned at all — this is a strictly
earlier, more severe failure point than the already-audited bulkTxHash scoping bug (prior
sessions), which at least has a real, local txHash value to lose. Here, there is nothing in the
client process to lose in the first place.

## 3. Case 1 — Receipt Timeout

txHash IS known to the client (line 343 succeeded). Only waitForTransactionReceipt (line 355)
times out or throws. Already fully audited in the prior two sessions: the fix is persisting
tx_hash immediately after line 343, before line 355 runs. This case is solvable entirely within
the existing design already checked into the implementation checklist — the client has
everything it needs; it simply isn't durably persisting it yet.

## 4. Case 2 — Broadcast Response Lost (this audit's actual subject)

sendTransaction itself never returns to the client — the tab/app closed, or the network
connection to the RPC provider was lost before the response (containing txHash) arrived, even
though the RPC provider/wallet had already accepted and possibly broadcast the transaction. The
client genuinely has no tx_hash to persist, at any point, on its own. Distinguishing this from
Case 1 matters precisely because no client-side timing fix (however early) can solve it — the
fix in §3 only works because the client eventually possesses the value; here it never does.

## 5. Case 3 — Broadcast Never Happened

The transaction was never actually accepted by any RPC provider at all (wallet rejection,
pre-flight RPC error, insufficient gas causing an immediate rejection). No money moved, nothing
to reconcile — the intent should simply transition to FAILED (already-supported transition),
exactly as the prior implementation checklist already specifies. Included here only to confirm
it is genuinely distinct from Cases 1/2 and requires no new mechanism.

---

## 6. Recovery Options — evaluated against current code, not assumed

### A. Frontend immediately persists tx_hash after broadcast response

Solves Case 1 only. Does not and cannot solve Case 2, by definition — if the frontend never
received the response, there is nothing for it to persist, no matter how immediately it would
try. Already the recommended fix for Case 1 (prior sessions); irrelevant to this audit's actual
question.

### B. Server-side broadcast through a trusted transaction service

Not compatible with the current architecture without a fundamentally larger redesign. Confirmed
directly: BulkPayoutPage.tsx restores the private key client-side (restorePrivateKey(),
useAuthStore) and signs client-side (privateKeyToAccount, createWalletClient) — this app's
entire security model is non-custodial, private keys never reach the server, confirmed and
re-confirmed throughout every phase of this whole engagement (the api/swap-proxy.js P0 finding
from the very first Phase 0 audit was exactly about not wanting raw private keys anywhere
server-accessible). Moving broadcast server-side would mean either (a) transmitting the private
key to the server (directly reintroducing the exact P0 vulnerability already fixed once), or (b)
a genuine custodial-signing redesign (HSM-backed signer, MPC, or similar) — a large, separate,
security-critical project, not a fix for this specific problem. Not recommended, not evaluated
further as a near-term option.

### C. Server-side reconciliation using intent + wallet + nonce

Technically possible — and the schema already anticipated it. Confirmed directly:
transaction_attempts.nonce bigint already exists in the Phase 1 migration, with an explicit
comment: "Supports future nonce-replacement" — written before this specific problem was ever
raised in this engagement. What's missing is a mechanism to turn "wallet X, nonce Y" into a
real tx_hash.

Important distinction, found this session, worth stating precisely: claim-recovery-scan's
existing findSourceBurnTx(sourceChain, nonce) (line 212) is a real, already-deployed "recover by
nonce" pattern — but it is a different kind of nonce. CCTP's DepositForBurn event emits its
nonce as an indexed event topic, so findSourceBurnTx can search via eth_getLogs with a
nonce-derived topic filter — a cheap, targeted, log-based lookup. A wallet's own EVM account
transaction nonce is not emitted as a log topic anywhere — it exists only as a field on the raw
transaction object itself (tx.nonce), retrievable only via eth_getBlockByNumber(..., true) (full
transaction list) or eth_getTransactionByHash (which requires already knowing the hash — useless
here). findSourceBurnTx's specific mechanism is not directly reusable; only the general "search
by nonce" concept transfers, not the implementation.

### D. Server-side reconciliation using block/transaction scanning

The mechanism Option C actually requires. blockchain-indexer/scanner.ts already calls
eth_getBlockByNumber(bn, true) (line 293) for its own, unrelated purpose (the native top-level
transfer scan, filtering by recipient). The same RPC method is already proven to work against
Arc, at scale, in production — a new, narrowly-scoped, wallet+nonce-targeted scan would reuse
this exact RPC call shape (not the existing function's code, which is filtered for a different
purpose, but the same primitive), bounded to a recent block range (since the attempt's
created_at), checking each block's transaction list for tx.from === wallet AND tx.nonce ===
expectedNonce.

C and D are therefore the same real mechanism, not two alternatives — C describes the data
needed (wallet + nonce, already schema-supported), D describes the only currently buildable way
to turn that data into a real tx_hash (a bounded block scan, since no log-based or other
targeted RPC lookup exists for account-level nonces on standard Arc RPC — UNVERIFIED whether
Arc's specific RPC providers expose any non-standard extension method for this; not tested in
this audit, no access to make a live RPC call of this kind).

### E. Wallet/RPC-specific recovery mechanism

UNVERIFIED, not evaluated further. Some wallet providers/RPC services expose a non-standard "get
transaction by nonce" or "get pending/recent transactions for address" endpoint. Whether Arc's
specific RPC infrastructure exposes any such extension was not checked in this audit — no live
RPC call was made. If such an endpoint exists, it would be strictly better than D (cheaper, more
direct) — but the safe, verified fallback is D regardless, since D relies only on the standard
eth_getBlockByNumber method already proven against Arc.

### F. Existing bulk_payments (or bulk_payments_received) as a recovery pointer

Cannot recover Case 2 at all. Both are written by the client, after a successful
waitForTransactionReceipt (confirmed, same code path traced in prior sessions) — in Case 2, the
client never even reaches that point, so neither table receives a row. Per your explicit
instruction, neither should ever be treated as blockchain truth regardless — this is stated here
only to confirm they are not just untrustworthy but structurally absent for this specific case.

### G. Another mechanism already present in the current codebase

None found that solves Case 2 specifically. claim-worker's own recovery logic, deposit-scan-all,
and claim-recovery-scan all solve analogous-sounding but structurally different problems
(recovering a destination-chain mint whose tracking record was never written, using event-topic
search — not recovering a broadcast whose response was never received at all). No existing
function reads eth_getBlockByNumber filtered by sender+nonce anywhere in this repository —
confirmed by search.

---

## 7. Security Analysis (all options, per your requested criteria)

| Option | Possible today? | Authoritative info | Client-controlled info | Unrelated-tx risk | Duplicate-payment risk | Recovers after tab close? | Schema change | Server change | Security risk | RPC cost | Works for N recipients? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | Yes, for Case 1 only | tx_hash itself | tx_hash (but genuinely known, not guessed) | None | None | No — irrelevant to Case 2 | None | None | None | None | Yes (Case 1) |
| B | No, without a custodial redesign | N/A | N/A (private key would need to move) | N/A | N/A | Yes, if built | Large | Large | Reintroduces the exact P0 finding from Phase 0 | N/A | N/A |
| C/D | Yes, with new work | The real, mined block/transaction data itself, read independently by the server | The intended nonce is currently only known client-side (§8 — a real, unresolved trust gap unless the server also independently records/reserves it) | See §8 — bounded but non-zero without a secondary verification step | See §8 — bounded, not zero, without the same secondary check | Yes — this is the entire point; works even if the client never comes back online | New reconciliation bookkeeping (not a new column — nonce already exists) | New, bounded, narrowly-scoped scan function | Low, if the secondary verification (§8) is included; meaningfully higher if omitted | Bounded — a fixed block range per unresolved attempt, not unbounded | Yes — the outer Multicall3 tx has exactly one nonce regardless of N |
| E | UNVERIFIED | Would depend on the specific extension | Same as C/D if built on top of it | Same as C/D | Same as C/D | Same as C/D | Same as C/D | Smaller, if it exists | Same as C/D | Potentially lower than D | Same as C/D |
| F | No | N/A | Entirely client-written, and absent in this exact case | N/A | N/A | No | N/A | N/A | N/A (moot — doesn't work) | N/A | N/A |
| G | No | N/A | N/A | N/A | N/A | No | N/A | N/A | N/A | N/A | N/A |

## 8. Duplicate Payment Risk — the precise, honest answer

Nonce-based recovery (C/D) is safe from duplicate payment, but only with a secondary
verification step — stated precisely, not glossed over.

A wallet's nonce is strictly sequential and can correspond to at most one ever-mined
transaction, unless the wallet later submits a genuine replacement with the same nonce (the
exact scenario transaction_attempts.status = 'REPLACED' already anticipates in the schema). This
means a block scan that finds some real, mined transaction from wallet_address with nonce =
expectedNonce could, in a real but narrow edge case, find a different transaction than the
intended BulkPay call — e.g., the user (or a different tab/session) used a wallet feature to
cancel/speed-up the original transaction with a replacement that does something else entirely,
and that replacement is the one that actually got mined.

The safe design therefore requires a secondary check, not nonce-match alone: once a candidate
transaction is found by (wallet, nonce), its `to` field must be independently verified as
Multicall3 (the same check bulkpayReconcile.ts's decodeBulkPayReceipt already performs, reused,
not invented) before treating it as confirmation of this BulkPay attempt. If the found
transaction's `to` does not match, the correct outcome is: this specific attempt -> REPLACED (a
real, already-supported state), and the original BulkPay payment genuinely never happened — the
user's payout attempt failed, requiring a new, explicit, separately-authorized intent to retry
(never an automatic rebroadcast, exactly per your instruction).

Can this accidentally identify an unrelated transaction? Only in the narrow replacement scenario
above, and only until the secondary to-address check is applied — after that check, no. Can it
cause duplicate payment? No — this mechanism only ever discovers a tx_hash for an attempt that
already has a reserved nonce; it never broadcasts anything itself, so it cannot cause a second
payment by construction, only correctly attribute or correctly reject a found candidate.

---

## 9. Recommended Architecture

Option C/D, with the secondary to-address verification from §8, is the recommended, practically
achievable design — the only option (besides the explicitly-rejected Option B) that can recover
Case 2 at all. Concretely:

```
Intent-creation endpoint (already planned, prior checklist item #1)
  -> server independently queries eth_getTransactionCount(wallet, 'pending') ITSELF
     (not trusting a client-supplied nonce) and persists it to transaction_attempts.nonce
     BEFORE returning to the client -- this is the one new ordering requirement Case 2's
     recovery depends on; without a server-independently-recorded nonce, there is nothing
     to reconcile against at all
  -> client is expected to broadcast using this exact, server-issued nonce (a client that
     used a different nonce would simply fail its own recovery path later -- not a security
     issue, since a different nonce would just mean this specific reconciliation mechanism
     can't help that attempt; the attempt would need to fall back to manual/support
     intervention, an accepted residual limitation, not silently unsafe)
  -> IF the client successfully returns a tx_hash (Case 1's normal path): persist it directly,
     no scan needed
  -> IF an intent/attempt is found in CREATED/BROADCASTING status for longer than a bounded
     grace period (e.g., a few minutes -- long enough to rule out ordinary Case 1 latency,
     short enough to bound the scan window) with NO tx_hash ever received: this is the Case 2
     signal -- trigger the block-scan reconciliation (D), bounded to blocks since
     attempt.created_at, searching for tx.from === wallet_address AND tx.nonce === attempt.nonce
  -> candidate found -> verify tx.to === Multicall3 (§8) -> if match: treat exactly like a
     normal Case 1 tx_hash discovery (persist it, proceed to CONFIRMING/UNKNOWN handling as
     already designed) -> if no match: attempt -> REPLACED, intent -> FAILED, no auto-retry
  -> no candidate found within a longer, final bound (e.g., the wallet's on-chain nonce at
     'latest' still equals or is below the reserved nonce, well past any reasonable broadcast
     window): the transaction very likely never actually broadcast at all -- converges to
     Case 3's handling (FAILED), not left open forever
```

## 10. Required Schema Changes

None beyond what the Phase 1 migration (already written, unapplied) already provides.
transaction_attempts.nonce already exists. No new column, table, or constraint is required by
this specific recovery mechanism — confirmed by direct schema re-read this session.

## 11. Required Server Changes

- The intent-creation endpoint (prior checklist item #1) must itself compute and persist the
  nonce server-side (not accept one from the client) — a refinement to that endpoint's own
  design, not a new endpoint.
- A new, narrowly-scoped block-scan reconciliation function (extends the UNKNOWN-reconciler
  already planned in the prior checklist, item #6, or a closely related sibling) — bounded scan
  range, the to-address verification from §8, and the same idempotent state-transition logic
  already designed (attempt -> CONFIRMED/UNKNOWN/REPLACED, never a second broadcast).

## 12. Required Frontend Changes

None beyond what the prior checklist already specifies (call the intent-creation endpoint before
broadcasting, using the server-issued nonce rather than computing its own via
publicClient.getTransactionCount) — Case 2's recovery is entirely a server-side capability; by
definition, nothing the frontend does differently can help a scenario where the frontend itself
is the thing that failed.

## 13. Recovery State Machine

Using only states already confirmed present in server/transactionStateMachine/types.ts
(unchanged, re-verified this session — no new state invented):

```
CREATED (nonce reserved, persisted server-side)
  -> BROADCASTING (client attempting sendTransaction)
    -> SUBMITTED (tx_hash received directly from client -- Case 1 path)
    -> [no tx_hash received, grace period elapses] -> block-scan reconciliation triggered
       -> candidate found, to === Multicall3 -> SUBMITTED (as if Case 1 had succeeded)
       -> candidate found, to !== Multicall3 -> REPLACED
       -> no candidate found, wallet's nonce still not advanced past a longer bound -> DROPPED
          (converges to Case 3's FAILED handling at the intent level)
SUBMITTED -> {CONFIRMING, UNKNOWN, REPLACED}  [already-existing transitions, unchanged]
```

## 14. Test Plan

1. Normal broadcast, tx_hash received directly (Case 1's existing coverage, unaffected).
2. Simulated Case 2: broadcast "succeeds" (a real transaction is mined) but the test harness
   never delivers the response to the code path under test — the block-scan reconciliation must
   find it via (wallet, nonce) and correctly verify to === Multicall3.
3. Simulated nonce-replacement: a different, real transaction with the same (wallet, nonce) is
   mined, to !== Multicall3 — must resolve to REPLACED, never CONFIRMED, never a second
   broadcast.
4. No transaction ever appears for (wallet, nonce) within the bound — must converge to FAILED,
   not remain open indefinitely.
5. The block-scan reconciliation run twice against the same unresolved attempt — must be
   idempotent (same outcome, no duplicate state transition attempted twice unsafely).
6. A BulkPay batch with N=100 recipients — confirm the scan is keyed on the ONE outer
   transaction's (wallet, nonce), not per-recipient, so N does not change this mechanism's cost
   or behavior at all.

## 15. Open Questions

- UNVERIFIED: whether Arc's specific RPC infrastructure exposes any non-standard, cheaper
  "transaction by nonce" lookup (Option E) — not tested in this audit, no live RPC call made of
  this kind. If confirmed to exist in a future session, it would be a strictly cheaper
  replacement for the block-scan mechanism (D), not a different design.
- Not resolved in this audit: the exact grace-period durations (§9's "a few minutes" for
  triggering the scan, and the longer final bound for converging to FAILED) — should be sized
  against real, measured Arc block/confirmation timing the same way TIMING_DIFFERENCE_
  THRESHOLD_MS was sized in an earlier session's Ledger work, not guessed; not measured in this
  audit.
- Not resolved: what happens if the wallet's nonce reservation itself (server independently
  querying eth_getTransactionCount(wallet, 'pending') at intent-creation time) races with some
  other, unrelated transaction from the same wallet (e.g., an ordinary Pay sent from a different
  tab moments earlier) — a real, if narrow, concurrency question this audit did not fully
  resolve, flagged rather than assumed away.
- A residual, accepted limitation, stated plainly: if the client used a different nonce than the
  server-issued one (e.g., a bug, or a client that ignores the server's value), this specific
  recovery mechanism cannot find it — this is not a security hole (nothing unsafe happens), but
  it is a real limitation on this mechanism's coverage, not fully closed by this design.

## 16. Final Recommendation

The current architecture cannot guarantee recovery from "broadcast succeeded + frontend never
received the response" using anything that exists today, unmodified. It can guarantee recovery
with the addition described in §9-§11 — server-independent nonce reservation (persisted before
broadcast) plus a bounded, to-address-verified block scan — using only RPC primitives already
proven against Arc in this codebase (eth_getBlockByNumber with full transactions) and a schema
column that already exists (transaction_attempts.nonce). This is not a new invention grafted
onto the architecture; it completes something the schema's own design comments already
anticipated ("supports future nonce-replacement") before this specific problem was raised.

This recommendation is additive to, not a replacement for, the previously-approved
implementation checklist — it specifically refines two of that checklist's items (the
intent-creation endpoint's nonce handling, and the UNKNOWN-reconciler's scope) rather than
introducing new files beyond what was already planned.

---

## Final Verification

- Exactly one documentation file changed: docs/BULKPAY_BROADCAST_RESPONSE_LOSS_AUDIT.md.
- Zero production code changes.
- Zero migrations applied.
- Zero deployments.
- Zero cron changes.
- Zero Ledger changes.
- Zero Activity/Balance/Notification changes.
- Zero production writes (only read-only repository/code inspection performed this session).

Not starting implementation. Stopping here for your review, per your instructions.
