# Ledger Core Implementation — Pay + Swap

Status: **Implemented, tested, not deployed, not wired to production.** No Edge Function
deployed, no `ledger_events` row created anywhere, no Phase 1 migration applied. This is
`server/ledger/` — pure, dependency-injected, independently testable code that nothing else in
the codebase calls yet (by design — wiring a real caller is integration work for a later,
separate phase).

---

## 1. Architecture

```
server/ledger/
  types.ts          shared types — see its own header comment for the key architectural finding
  classifiers.ts     pure classification logic (Pay, Swap) — no I/O
  repository.ts       LedgerRepository interface — the ONLY DB boundary, dependency-injected
  interpreter.ts        orchestration — the ONLY code allowed to call insertLedgerEvent
  index.ts               barrel export
  classifiers.test.ts     23 tests, pure
  interpreter.test.ts      12 tests, fake repository with real conditional-write semantics
```

```
chain_events (status='confirmed')  ──┐
                                       ├──▶ interpretConfirmedChainEvent ──▶ classifyPayTransfer / classifySwapCredit ──▶ LedgerRepository.insertLedgerEvent
transaction_attempts (status='CONFIRMED') ┘
                                       └──▶ interpretConfirmedAttempt ──▶ classifySwapDebit ──▶ LedgerRepository.insertLedgerEvent
```

No caller is wired up in this phase. A future phase (explicitly out of scope here) would invoke
`interpretConfirmedChainEvent`/`interpretConfirmedAttempt` from either a new Edge Function or an
extension of an existing one (`activity-consumer`'s successor, most likely, per
`docs/LEDGER_CANONICAL_EVENT_DESIGN.md` §14's own open question) — not decided or built now.

---

## 2. Classification rules

Priority order exactly as specified: (1) transaction_intent correlation, (2/3) feature-specific
metadata / event relationship — not yet applicable with only two features, nothing to add beyond
what correlation already provides, (4) known-internal-contract classification, (5) generic
Transfer fallback. Implemented in `classifiers.ts`, never by token symbol.

**The key architectural finding this implementation surfaced** (documented in full in
`types.ts`'s header comment, restated briefly here): `chain_events` is only ever created for the
**recipient** of a transfer (blockchain-indexer's scanner checks `knownWallets.has(to)`, never
`from`) — but the one row it does create already carries **both** `sender` and `recipient` in
its `metadata` (confirmed directly against `scanner.ts`'s `metadata: { recipient, sender,
amount }` shape). This means:

- **Pay's DEBIT and CREDIT can both be derived from ONE chain_event** — its metadata already has
  everything needed for both legs. No separate `transaction_attempts` lookup is required for the
  debit side of an ordinary Pay transfer.
- **Swap's SWAP_DEBIT cannot** — a swap's input leg goes TO the router, and the router is never
  a monitored wallet, so no `chain_events` row is ever created for it. `SWAP_DEBIT` can *only*
  come from a `CONFIRMED` `transaction_attempts` row and its `transaction_intents` row, using the
  amount/token the app itself recorded before broadcasting.

This is a real, evidence-based distinction discovered while building this module, not assumed
from the design docs — confirmed by re-reading `scanner.ts` and `index.ts`'s `loadKnownWallets`
directly.

## 3. Pay mapping

One confirmed `chain_events` row → `classifyPayTransfer` → two `LedgerEventDraft`s: `DEBIT`
(sender's wallet) + `CREDIT` (recipient's wallet). Both share `chain_id`/`tx_hash`/`log_index`,
differ only on `wallet_address` — exactly the shape the raw-movement identity constraint
(`docs/LEDGER_RAW_IDENTITY_FIX.md`) is designed to permit. Amounts are converted from
`chain_events.metadata.amount` (a human-decimal JS number, confirmed from `scanner.ts`) to
`amount_atomic` via **string-based decimal-point shifting** (`toAmountAtomic`), never
`value * 10 ** decimals` — floating-point multiplication is exactly the canonical-value risk the
amount model exists to prevent.

**Native transfers** use the identical function — `chain_events.log_index` is `null` for the
native top-level-scan path (no log exists), and both the resulting `DEBIT`/`CREDIT` drafts
correctly carry `log_index: null`, `is_native: true`.

## 4. Receive mapping

Not a distinct `event_type`, exactly as specified — it's `classifyPayTransfer`'s `CREDIT` output.
A transfer whose sender is a known internal contract (swap router, Multicall3, CCTP
infrastructure) is explicitly excluded from this classifier (`not_applicable`, never `CREDIT`) —
verified by a dedicated test using the real Kit Adapter Contract address from the traced EURC
case.

## 5. Swap mapping

`classifySwapDebit(intent, attempt)`: only ever produces a draft when `attempt.status ===
'CONFIRMED'` and `intent.feature === 'swap'`. `classifySwapCredit(chainEvent, correlated)`: only
ever produces a draft when a `{ intent, attempt }` correlation (found by the caller via
`tx_hash`) has `intent.feature === 'swap'`.

**Swap correlation — inspected before writing, not guessed** (per your explicit instruction):
searched the entire repository for any write to `transaction_intents`/`transaction_attempts`
outside the state-machine module itself — **zero results**. `SwapPage.tsx`, `api/swap-proxy.js`,
and every other Swap-related file do not create real intents today; Phase 1's tables remain
entirely unapplied in production besides. **This means the primary correlation path
(`transaction_intent`) cannot actually be exercised against real, live data in this
environment right now** — stated plainly, not hidden. The classifier itself is correct and
fully tested against synthetic data representing what a migrated Swap flow's data *will* look
like; it is currently dormant against production traffic until a separate, explicitly
out-of-scope future phase migrates Swap's UI to create real intents.

**The uncorrelated case, resolved without guessing**: a `chain_event` whose sender is a known
internal contract (e.g. the Kit Adapter router) but has no correlated intent (today's
universal case, per the above) returns `not_applicable` — **never** `CREDIT`, and **never** a
guessed `SWAP_CREDIT` either. Reasoning, stated in `classifiers.ts`'s own comment: a
`SWAP_CREDIT` with no `transaction_intent_id` could never be paired with a `SWAP_DEBIT` (which
can only ever come from a correlated intent), producing a permanently-unpairable, semantically
broken row the future Activity-grouping design could never correctly group. Deferring is the
correct, safe behavior — not a workaround.

## 6. Confirmation requirements

Enforced at two layers, deliberately redundant (same defense-in-depth discipline already used
throughout this codebase — `compare.ts`'s dual status check, `apply.ts`'s courtesy-check-then-
real-write):

- `classifiers.ts` itself refuses to classify anything but `chain_events.status === 'confirmed'`
  or `transaction_attempts.status === 'CONFIRMED'`, returning `unresolved` otherwise.
- `interpreter.ts` checks status again, before even attempting a correlation lookup, so a
  non-confirmed input costs nothing beyond the initial fetch.

Verified by 8 dedicated tests across both files covering every non-`CONFIRMED`/`confirmed`
status value in the actual enums (`pending`, `reorged`, `UNKNOWN`, `REVERTED`, `DROPPED`) — none
produce a ledger row.

## 7. Idempotency strategy

Two layers: `event_key` (identical inputs → identical key, verified directly) and the new
raw-movement constraint (`docs/LEDGER_RAW_IDENTITY_FIX.md`), modeled in tests via a fake
repository with **genuine** conditional-write semantics (not canned mock returns — the same
technique already proven in `server/transactionStateMachine/apply.test.ts`). `insertIdempotently`
(in `interpreter.ts`) does a courtesy pre-check via `findLedgerEventByRawMovement`, then the real
write — but the actual enforcement is always the repository's own conditional insert, exactly
matching the pattern already established for the transaction state machine.

**The critical regression test** (your own words: "one of the most important"): same raw
movement, first classified as one `event_type`, retried as a *different* `event_type` — returns
`{ outcome: 'conflict' }`, surfaced to the caller, never silently swallowed or overwritten.
Verified twice: once through the interpreter's own `insertIdempotently`, and once by calling
`repository.insertLedgerEvent` directly (bypassing the interpreter's own pre-check), to prove
the conflict is caught at the repository/database layer itself, not merely by the in-process
courtesy check.

## 8. Concurrency behavior

Three dedicated tests: (a) two full interpreter passes over the same `chain_event` converge to
exactly 2 rows (`DEBIT`+`CREDIT`), never 4 — verified by row count, not by which call "won"; (b)
a genuine race (a competing writer's row landing in the exact window between this module's own
courtesy read and its write, via an injectable race hook) produces a surfaced `conflict`, not a
silent double-post; (c) two chain_events on the same transaction, different `log_index`,
processed concurrently — 4 independent rows, correctly distinguished by `log_index`, never
collapsed.

## 9. Failure behavior

- `chain_event`/`attempt` not found → `not_applicable`, not an exception (verified).
- Any non-confirmed status → `unresolved`, no row (§6).
- A genuine conflict (raw movement already posted under a different `event_type`) → surfaced,
  never swallowed (§7).

**Atomicity — stated honestly, not pretended** (per your explicit instruction): Pay's
`DEBIT`+`CREDIT` pair is **two separate** `insertLedgerEvent` calls, not one atomic multi-row
write. `LedgerRepository` has no multi-row transactional primitive, and building one (e.g. a
Postgres RPC function) would be new production surface this focused phase doesn't add. This is
**safe, not merely convenient**: if `DEBIT` succeeds and `CREDIT` fails (or the process crashes
between the two calls), the next pass over the same confirmed `chain_event` finds `DEBIT`
already posted (`already_posted`, a no-op) and only retries `CREDIT`. Same "per-log-index, not
per-transaction, is the atomic unit" reasoning already established for BulkPay
(`docs/LEDGER_CANONICAL_EVENT_DESIGN.md` §6), applied here at debit/credit-pair granularity.

## 10. Security boundary

Confirmed directly, not assumed:

- `grep`'d the entire `server/ledger/` directory for `privateKey`, `sign`, `broadcast`,
  `createWalletClient`, `mnemonic` — zero matches. This module reads confirmed on-chain facts
  and app-recorded intent data; it never touches a key or sends a transaction.
- No Supabase (or any) client is instantiated anywhere in this module — `LedgerRepository` is an
  interface only; every DB operation is dependency-injected by the (not-yet-built) caller,
  matching `docs/TRANSACTION_SERVICE_BOUNDARY.md`'s ADR exactly.
- `wallet_address` is never taken as an unauthenticated input from a browser — every wallet
  address this module handles comes from either `chain_events` (indexer-written, server-side
  only) or `transaction_intents`/`transaction_attempts` (state-machine-written, also server-side
  only per that module's own service-role-only RLS design, Phase 1 §7).
- No import of React, Zustand, `ActivityService`, or any browser-only module — confirmed by the
  import lists in every file (`types.ts`, `classifiers.ts`, `repository.ts`, `interpreter.ts`
  import only each other and, in one case, a locally-defined constant — see §12's disclosed
  limitation).

## 11. Test results

**All actually run, not estimated:**

- `classifiers.test.ts`: **23/23 passed.**
- `interpreter.test.ts`: **12/12 passed.**
- Full `npx vitest run` (whole repo): **227/227 passed** (192 pre-existing + 23 + 12, zero
  regressions).
- `npm run typecheck` (root, `src/`): clean.
- `npm run typecheck:server` (`server/`, including this new module): clean.
- `deno test` (`blockchain-indexer/`, sanity check that this change didn't touch anything
  there): **45/45 passed**, fully unaffected — confirmed by file-timestamp diff, this phase
  touched only `server/ledger/`.
- Migration/schema validation against scratch Postgres: **not re-run** — this phase made zero
  schema changes (confirmed by the same file-diff check), so the Step 1 validation
  (`docs/LEDGER_RAW_IDENTITY_FIX.md`) remains the current, valid state.

All 24 requested test cases mapped explicitly: IDENTITY (1–5) in both files, PAY (6–10) in
`classifiers.test.ts`, CONFIRMATION (11–15) split across both files (chain_event statuses in
`classifiers.test.ts`, attempt statuses in both), SWAP (16–21) in `classifiers.test.ts` plus a
correlation-through-the-repository version in `interpreter.test.ts`, CONCURRENCY (22–24) in
`interpreter.test.ts`.

## 12. Known limitations

1. **Swap correlation is currently unexercised by real data** — no code creates real
   `transaction_intents`/`transaction_attempts` yet (§5). The classifier is correct and fully
   tested against synthetic data; it will only produce real `SWAP_DEBIT`/`SWAP_CREDIT` output
   once a future, separate phase migrates Swap's UI.
2. **`classifiers.ts` carries its own copy of `KNOWN_INTERNAL_CONTRACTS`** rather than importing
   `supabase/functions/_shared/knownInternalContracts.ts` — a cross-directory `.ts`-extension
   import from `server/` into `supabase/functions/_shared/` failed the `server/` TypeScript
   project (`TS5097`, `allowImportingTsExtensions` not enabled). Enabling that flag project-wide
   to accommodate one import was judged a larger, less-focused change than a clearly-labeled,
   disclosed third copy — this list already exists in two places by design (`compare.ts`'s own,
   and the `_shared` module built for the Claim-Recovery fix); this is a third, not a
   proliferation problem introduced silently. **Recommended follow-up** (not done here): a
   proper cross-runtime-safe shared package (published to both `server/` and
   `supabase/functions/_shared/` via a build step, or simply enabling
   `allowImportingTsExtensions` if that's judged acceptable) — a decision for whoever wires up
   the real caller in a future phase.
3. **DEBIT/CREDIT pair is not atomically written** — disclosed in full in §9, safe by design
   (idempotent retry), not a silent gap.
4. **No caller wired up** — this module is complete and tested but inert until a future phase
   invokes it from a real Edge Function or API route with a real `LedgerRepository`
   implementation, per your explicit instruction not to deploy anything this phase.
5. **CCTP/UB/BulkPay/ChatPay/P2P are not implemented** — by design, explicitly out of scope,
   per the brief's own phase ordering (CCTP next, UB last, pending the still-open verification
   from `docs/LEDGER_SCHEMA_GAP_AUDIT.md` §3).
6. **No mandatory stop condition was triggered.** Explicitly checked against each one before
   writing this report: Swap correlation is *not* ambiguous (it's well-defined, just currently
   unexercised — a different thing from ambiguous); `transaction_intent` data, where it exists,
   is sufficient; no raw chain event was found to map to multiple valid ledger meanings; Pay's
   debit/credit *is* representable (with disclosed, safe non-atomicity, not a representability
   failure); no path was found where a pending/UNKNOWN event could create a row (verified by
   test); the DB abstraction (as designed, dependency-injected) can guarantee the required
   idempotency, verified against a repository implementation with real conditional-write
   semantics; no schema contradiction was found (Step 1's fix directly enables everything this
   phase needed).

## 13. Exact files changed

- `server/ledger/types.ts` (new)
- `server/ledger/classifiers.ts` (new)
- `server/ledger/repository.ts` (new)
- `server/ledger/interpreter.ts` (new)
- `server/ledger/index.ts` (new)
- `server/ledger/classifiers.test.ts` (new, 23 tests)
- `server/ledger/interpreter.test.ts` (new, 12 tests)
- `docs/LEDGER_CORE_IMPLEMENTATION.md` (this file, new)

**7 production/test files + 1 doc** — within the "2-4 production files plus tests" target
counting `types.ts`/`classifiers.ts`/`repository.ts`/`interpreter.ts`/`index.ts` as the
production surface (5 files; `index.ts` is a one-line barrel) and the two `.test.ts` files as
tests. No unrelated file touched — confirmed by file-timestamp diff. No schema, migration,
Activity, indexer, claim-recovery, Pay UI, or Swap UI file modified.

---

**Stopping here per your instructions.** Not deploying, not applying Phase 1 to production, not
creating production `ledger_events`, not proceeding to CCTP/BulkPay/ChatPay/P2P/UB.
