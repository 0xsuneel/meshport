# Claim-Recovery Sender-Classification Fix (interim mitigation)

Status: **Implemented and verified.** Narrow, focused change — CCTP claim detection/matching
logic, the indexer, and `ActivityService` are all untouched.

**This is an interim mitigation. It does NOT replace the final Ledger architecture.** It closes
the specific, traced race (`docs/ACTIVITY_WRITER_AUDIT.md` §2, `docs/CLAIM_RECOVERY_AUDIT.md`
§5) by adding structural sender-based classification ahead of the existing timing-dependent
guard — it does not redesign Activity, does not remove the generic-receive branches
`docs/CLAIM_RECOVERY_AUDIT.md` recommended narrowing later, and does not touch claim recovery's
actual purpose (recovering claims the app never durably tracked).

---

## Original problem (restated precisely, from the prior audit)

`claim-recovery-scan`'s four generic-receive branches classified **every** incoming Transfer as
a candidate external deposit, relying entirely on `existsActivityForTxHash`'s timing-dependent
poll (3 checks over ~3 seconds) to detect "this was already accounted for by another writer."
When a competing writer's own Activity row (a swap, a BulkPay payout, a P2P release) landed
*after* that 3-second window elapsed, the poll incorrectly concluded nothing existed yet and
wrote a spurious `receive` row alongside the correct one.

## The EURC race (exact, from the prior audit)

Transaction `0xed2868e6d034e65d2a0063816906dd2d69602ce9a7a71a08fbf78c7492312`: an EURC `Transfer`
from the **Kit Adapter Contract** (`0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b`, a swap router)
to the user's wallet — the swap's output leg. `claim-recovery-scan`'s EURC/cirBTC branch (then
lines 861-903) had no concept of "this sender is a known internal router" — it fell straight
through to the generic-receive path, checked `existsActivityForTxHash`, found nothing yet (the
client's own `swap` Activity write landed ~1.6s later, outside the poll's effective window at
that particular invocation), and wrote a `receive` row. Result: two Activity rows for one
transaction.

## The classification rule (implemented)

```
Transfer
  ↓
sender is a known internal contract?
  │
  ├── YES → do NOT create generic RECEIVE (skip, before existsActivityForTxHash)
  │
  └── NO  → continue to existsActivityForTxHash() as before (second layer of defense)
```

Applied to **all four** generic-receive branches in `claim-recovery-scan/index.ts` — the
USDC-wrapper non-mint branch, the `!isCctpMint` fallback, the EURC/cirBTC loop (the exact branch
that produced the traced duplicate), and the native-USDC-via-explorer branch. In every case the
sender check runs **before** `existsActivityForTxHash`/`recordExternalReceive`, exactly as
required — the timing-dependent poll is now a second layer of defense (useful for a sender not
yet in the known-internal list), not the only line of defense.

## Internal-contract sources — how the existing canonical list was reused

Inspected `blockchain-indexer/compare.ts`'s `KNOWN_INTERNAL_CONTRACTS` directly (not from
memory) before writing anything. **8 of the resulting list's 9 addresses are an exact,
byte-for-byte copy of that list.** The 9th — Multicall3
(`0xcA11bde05977b3631167028862be2A173976CA11`) — is **not** in `compare.ts`'s current list
(re-verified directly against the live source); it was added because this task explicitly
requires excluding Multicall3/BulkPay senders, and because a real Multicall3-sent transaction
was independently traced against live production `chain_events` data during the Phase 3
forensic audit (`docs/PHASE_3_REAL_STATE_AUDIT.md` §8, tx `0x435d804c…`), confirming this is the
genuine sender address, not a guess. This is disclosed explicitly rather than silently presented
as "the same list" — it isn't quite, and the one addition is evidenced, not invented.

**Where it lives**: `supabase/functions/_shared/knownInternalContracts.ts` — a new, genuinely
shared module. `compare.ts` was **not** modified to import from it (that would be an indexer
change, explicitly out of scope) — its own copy remains, kept in sync manually for now, the same
relationship `compare.ts`'s own comments already describe having with `deposit-scan-all`'s copy.
A future, indexer-scoped change should converge `compare.ts` onto this shared module and decide
whether to add Multicall3 to its own list too — not decided here.

**Why `_shared/` and not a fresh inline copy**: verified first that cross-directory imports from
`supabase/functions/_shared/` are an already-proven, already-deployed pattern in this exact
codebase — `wallet-key`, `claim-submit`, and `p2p-release-reconcile` all already import from
`_shared/` in production. This is not a novel or risky import path; it's the established
convention, now used by `claim-recovery-scan` too.

## Why unknown senders remain eligible

`isKnownInternalContract()` only ever returns `true` for an address explicitly present in the
static list or supplied via its `extra` parameter — there is no heuristic, no "looks like a
contract" check, no broad exclusion. An address the codebase has never confirmed as an internal
MeshPort flow is always treated as a genuine external sender, exactly as before this change.
Verified directly by tests #5/#6 (`knownInternalContracts.test.ts`).

## P2P escrow — handled without fabricating an address

No P2P escrow contract address was ever confirmed configured in every environment
(`docs/PHASE_3_EVENT_COVERAGE_MATRIX.md`'s own P2P rows, and `p2pProviders.ts`'s
`HonorSystemFallbackEscrowProvider`, both already noted this). Rather than hardcode a guessed
address, `isKnownInternalContract()` accepts an optional `extra` parameter, and
`claim-recovery-scan/index.ts` reads the **already-established** env var names
`p2p-release-reconcile/index.ts` uses for the exact same purpose (`P2P_ESCROW_CONTRACT`,
`P2P_ESCROW_CONTRACTS_LEGACY`) and passes them through. If configured in this project's secrets,
it's excluded automatically; if not, it's simply not excluded — no fabricated data either way.

## CCTP claim safety

**Not altered, verified by direct inspection of the diff:** `address(0)` mint detection
(`isMint`), `MessageReceived` decoding, `resolveSourceChain`, the `claims` table matching logic
(the candidate-pool/amount-matching block), `recordClaimActivity`, and
`reconcileFailedClaimActivity` are all byte-for-byte unchanged. The one mint-adjacent branch
touched is the `!isCctpMint` fallback (an address(0) transfer that turns out NOT to be a real
CCTP mint) — this is already, by the existing code's own design, a generic-receive branch, not
claim-matching logic; the classification check added there is a no-op in practice (its sender is
always `address(0)` by construction, which never matches the internal-contract list) and exists
only for consistency with the other three branches, not because it changes real behavior.

## Tests

`supabase/functions/_shared/knownInternalContracts.test.ts` — **10/10 passing**:

| # | Test | Status |
|---|---|---|
| 1 | known swap router (Kit Adapter) → excluded | ✅ |
| 2 | known Multicall3 → excluded | ✅ |
| 3 | known P2P escrow (via `extra`) → excluded | ✅ |
| 4 | known internal contract (CCTP TokenMessenger) → excluded | ✅ |
| 5 | unknown EOA → RECEIVE eligible | ✅ |
| 6 | unknown contract → RECEIVE eligible | ✅ |
| 9 | EURC swap-output regression (exact traced sender) | ✅ |
| 11 | case-insensitive address matching | ✅ |
| 12 | no duplicate address-list (structural size check) | ✅ |
| — | null/undefined/empty never throws | ✅ |

**Tests 7, 8, 10 — verified by code inspection, not by an executed runtime test, disclosed
explicitly:** `claim-recovery-scan/index.ts` has no exported, independently-callable functions
(everything runs inside one `Deno.serve` handler using a live Supabase client and real `fetch`)
— unlike `blockchain-indexer/scanner.ts`/`compare.ts`, which were already designed for
testability. Refactoring the 990-line handler to extract testable seams was judged out of scope
for an "extremely focused," 1-3-production-file change. Instead:
- **Test 7** (genuine CCTP mint unaffected): verified by direct diff inspection — the mint-
  detection/`resolveSourceChain`/claims-matching code path was not touched at all, confirmed
  line-by-line above ("CCTP claim safety").
- **Test 8** (self-transfer unaffected): verified by diff inspection — the existing self-
  transfer check (`fromAddress === walletAddress`) is unchanged in every branch; only its
  position relative to the new classification check (both now run before
  `existsActivityForTxHash`) changed, not its logic.
- **Test 10** (native USDC external receive remains eligible): verified by diff inspection — the
  native-via-explorer branch's classification check only excludes addresses actually present in
  `KNOWN_INTERNAL_CONTRACTS`/`extra`; an ordinary external sender continues to `recordExternalReceive`
  exactly as before, unchanged code path.

## Validation run

- `deno test supabase/functions/_shared/knownInternalContracts.test.ts`: **10/10 passed**.
- `deno test supabase/functions/blockchain-indexer/`: **45/45 passed** (unchanged — nothing in
  the indexer was touched).
- `npx vitest run` (full suite): **192/192 passed** (unchanged).
- `npm run typecheck`: clean.
- `deno check supabase/functions/_shared/knownInternalContracts.ts`: clean.
- `deno check supabase/functions/claim-recovery-scan/index.ts` (against a local stub for the
  network-blocked `jsr:@supabase/supabase-js` import, same documented sandbox limitation as
  every prior Deno-side pass): **2 pre-existing errors found, confirmed unrelated and not
  introduced by this change** — `TS7006` implicit-`any` on two `.filter()` callbacks inside the
  claims-matching candidate-pool logic (lines 773-774), well outside every site this change
  touched, inside the exact `claims table matching` block this task explicitly forbids altering.
  Left untouched, disclosed here rather than silently left unmentioned.

## Known limitations

- Only closes the race for senders already in the known-internal list. An unrecognized internal
  contract (a future feature's own router/escrow, not yet added here) still relies on the
  timing-dependent poll as its only defense — exactly the same residual risk
  `docs/BULKPAY_ACTIVITY_SAFETY_FIX.md` already disclosed for its own guard.
- P2P escrow exclusion is conditional on `P2P_ESCROW_CONTRACT`/`P2P_ESCROW_CONTRACTS_LEGACY`
  actually being configured in this project's secrets — not independently verified in this pass
  (no tool access to secret values, only to code that reads them).
- `compare.ts` and this new shared module now have two lists that must be kept in sync manually
  until a future indexer-scoped change converges them — an explicit, disclosed, temporary
  duplication-of-maintenance-burden (not of data — the shared module is the single source of
  truth going forward), not a duplicate detector.

## Files changed

- `supabase/functions/_shared/knownInternalContracts.ts` — new, the canonical shared list +
  `isKnownInternalContract()`.
- `supabase/functions/claim-recovery-scan/index.ts` — sender-classification check added to all
  four generic-receive branches, plus the new import and two new env-var reads for P2P escrow.
- `supabase/functions/_shared/knownInternalContracts.test.ts` — new, 10 tests.
- `docs/CLAIM_RECOVERY_SENDER_CLASSIFICATION_FIX.md` — this file.

**2 production files, 1 test file, 1 doc — within the requested budget.** `compare.ts`, the rest
of the indexer, and `ActivityService.ts` are all confirmed untouched (file-timestamp check).

---

**Not deployed automatically, per your instructions.** Stopping here for review — not starting
Ledger.
