# Transaction State Machine

Status: Phase 2 — **the shared state machine module only**. Nothing in Pay, Receive, Swap,
Multichain Transfer/Claim, BulkPay, ChatPay, or P2P calls this yet. The indexer, `wallet-key`,
and `swap-proxy` are untouched. See §9 for exactly what is (and isn't) wired up.

Code: `server/transactionStateMachine/` (`types.ts`, `transitions.ts`, `apply.ts`, `index.ts`).

---

## 1. Why three separate status fields

An intent, its attempt(s), and its ledger event(s) can legitimately be in different states at
the same moment — e.g. intent `SUBMITTED`, attempt `UNKNOWN`, no ledger event yet at all. A
single overloaded status column cannot represent that; three columns, each with their own
transition table, can. This was decided in Phase 1
(`docs/PHASE_1_SCHEMA_DESIGN.md` §3) — Phase 2 is where that decision gets enforced in code
instead of merely documented in SQL comments.

---

## 2. State definitions

### 2.1 Intent status (`transaction_intents.status`)

| State | Meaning |
|---|---|
| `DRAFT` | User is still filling in the request; nothing has been reviewed or signed |
| `REVIEWED` | User has seen a final review screen (amount, recipient, fee) |
| `AUTHORIZING` | User is in the process of signing (wallet prompt, biometric, passcode) |
| `SUBMITTED` | At least one attempt has been broadcast for this intent |
| `CONFIRMED` | The intent's outcome is settled and successful — **terminal** |
| `FAILED` | The intent's outcome is settled and unsuccessful — **terminal** |
| `CANCELLED` | User backed out before ever submitting — **terminal** |
| `EXPIRED` | Abandoned before submission and no longer actionable (e.g. an old swap quote) — **terminal** |

### 2.2 Attempt status (`transaction_attempts.status`)

| State | Meaning |
|---|---|
| `CREATED` | Attempt row exists; nothing sent to the network yet |
| `BROADCASTING` | The signed transaction is being sent to the network right now |
| `SUBMITTED` | The network has a `tx_hash` for this attempt |
| `UNKNOWN` | Broadcast may have succeeded; confirmation could not be established (see §4) |
| `CONFIRMING` | A receipt was found; waiting to reach the chain's required confirmation depth |
| `CONFIRMED` | Reached confirmation depth, receipt shows success — **terminal** |
| `REVERTED` | Reached confirmation depth, receipt shows revert — **terminal** |
| `DROPPED` | Confirmed absent from the mempool and never mined — **terminal in Phase 2** (see §6) |
| `REPLACED` | Superseded by a different attempt (nonce replacement/speed-up) — **terminal for this row** |

### 2.3 Ledger settlement status (`ledger_events.settlement_status`)

| State | Meaning |
|---|---|
| `PENDING` | Event observed but not yet past the chain's confirmation-depth policy |
| `POSTED` | Safe to treat as real — balances, Activity, and notifications may use it |
| `REVERSED` | A reorg retracted the underlying chain event — kept, never deleted (audit trail) |

### 2.4 Application-level composite: `SUBMITTED_UNKNOWN`

Not a database value anywhere. `deriveDisplayState(intent, attempts)` combines
`intent.status === 'SUBMITTED'` with the latest attempt's status: if that attempt is `UNKNOWN`,
the derived display state is `SUBMITTED_UNKNOWN`; otherwise it's whatever the intent's real
status is. This is exactly what the brief asked for — `"SUBMITTED_UNKNOWN` at the application
level / `UNKNOWN` at attempt level" — implemented as a pure read-time derivation rather than a
stored, potentially-stale ninth intent status.

---

## 3. Transition diagram

```
INTENT
  DRAFT ───────► REVIEWED ───────► AUTHORIZING ───────► SUBMITTED ───────► CONFIRMED (terminal)
    │                │                   │                    │
    ▼                ▼                   ▼                    ▼
 CANCELLED        CANCELLED           FAILED               FAILED
 (terminal)       EXPIRED           CANCELLED             (terminal)
                  (terminal)        (terminal)

  (FAILED, CANCELLED, EXPIRED, CONFIRMED all terminal — no outgoing edges.
   FAILED → CONFIRMED is explicitly NOT a valid edge: no documented
   recovery model exists at the intent level in Phase 2.)


ATTEMPT
  CREATED ──────► BROADCASTING ──────► SUBMITTED ──┬──► CONFIRMING ──┬──► CONFIRMED (terminal)
    │                  │                           │        │        └──► REVERTED (terminal)
    ▼                  ▼                           │        ▼
  DROPPED           DROPPED                        │     UNKNOWN ◄──────────────┐
  (terminal)        (terminal)                      │        │                  │
                                                     │        ├──► CONFIRMED     │
                                                     ├──► UNKNOWN ├──► REVERTED  │
                                                     │        └──► DROPPED       │
                                                     └──► REPLACED (terminal for this row)
                                                                                  │
                                                          (CONFIRMING can also go │
                                                           back to UNKNOWN if a   │
                                                           mid-poll RPC failure   │
                                                           loses the receipt) ────┘


LEDGER EVENT
  PENDING ──────► POSTED ──────► REVERSED
     │                              │
     └─────────────► REVERSED ◄─────┘
                         │
                         └──────► PENDING   (reorg-recovery exception, see §7 — the ONLY
                                              edge leaving a nominally-terminal state)
```

---

## 4. The UNKNOWN rule (critical)

**If a broadcast may have succeeded but confirmation could not be established (RPC timeout,
dropped connection, etc.), the attempt moves to `UNKNOWN` — never straight to a failure state.**

```
sign → broadcast → tx_hash exists → waitForReceipt times out
                                            │
                                            ▼
                                        UNKNOWN
                                            │
                              (reconciler determines truth later)
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    ▼                       ▼                       ▼
                CONFIRMED               REVERTED                DROPPED
```

Enforced in code, not just by convention: `ATTEMPT_TRANSITIONS.SUBMITTED` does not include any
failure-shaped state at all — its only edges are `CONFIRMING`, `UNKNOWN`, `REPLACED`. There is no
`FAILED` value in the attempt enum; the closest thing, `REVERTED`, is reachable only from
`UNKNOWN` or `CONFIRMING`, never directly from `SUBMITTED`. It is structurally impossible to call
`transitionAttempt(id, 'REVERTED')` on a `SUBMITTED` attempt — `validateAttemptTransition` throws
`InvalidTransitionError` before any write happens.

**No automatic retry.** Nothing in this module creates a new attempt row on its own when one
goes `UNKNOWN`. A replacement (§6) is always a deliberate act by calling code (a future phase's
reconciler or user-initiated speed-up), never implicit here.

At the intent level, the *intent* simply stays `SUBMITTED` while its attempt is `UNKNOWN` — there
is no forced intent transition at all. `deriveDisplayState` is what turns that into
`SUBMITTED_UNKNOWN` for anything rendering it to a user (§2.4).

---

## 5. Invalid transitions (examples, non-exhaustive)

| Attempted | Why invalid |
|---|---|
| `CONFIRMED → DRAFT` (intent) | `CONFIRMED` is terminal |
| `FAILED → CONFIRMED` (intent) | No documented recovery/replacement model at the intent level |
| `REVERTED → SUBMITTED` (attempt) | `REVERTED` is terminal |
| `SUBMITTED → REVERTED` (attempt, direct) | Must pass through `UNKNOWN` or `CONFIRMING` — never skip straight from "has a hash" to "confirmed-reverted" without at least attempting confirmation |
| `POSTED → PENDING` (ledger) | Must go through `REVERSED` first — a posted event doesn't quietly become unposted |
| `REVERSED → POSTED` (ledger, direct) | Recovery must re-earn confirmation depth via `PENDING` (§7), not jump straight back to `POSTED` |

Every one of these throws `InvalidTransitionError` (with `.entity`, `.from`, `.to` on the error
object) rather than silently no-op-ing or silently succeeding.

---

## 6. Replacement transactions

```
Attempt A: SUBMITTED ──► REPLACED                (terminal for A)
Attempt B: CREATED ──► SUBMITTED ──► CONFIRMED    (a brand-new row, its own id)

Intent:    SUBMITTED ──────────────► CONFIRMED    (via B — A's replacement never forces FAILED)
```

A replacement is **always a new `transaction_attempts` row**, never a transition target on the
old one. `REPLACED` has no outgoing edges — once set, that row is done. The intent reaches
`CONFIRMED` through whichever attempt actually confirms; the earlier attempt being `REPLACED`
has no direct effect on intent status at all (calling code decides when to call
`transitionIntent(..., 'CONFIRMED')`, typically once *any* of its attempts confirms).

`DROPPED` is intentionally terminal in Phase 2, for the same reason `FAILED` is terminal at the
intent level: a dropped transaction reappearing on-chain is a real (if rare) edge case that
needs its own explicit, documented recovery design — not a quiet transition added here without
that design existing yet. If/when Phase 3 or 4's reconciler defines that recovery model, this
table gains a new documented edge at that point, the same way `REVERSED → PENDING` (§7) was
added as an explicitly documented exception rather than a blanket "terminal states aren't really
terminal."

---

## 7. Reorg behavior

`REVERSED → PENDING` is the **one** exception to "terminal states stay terminal," and it exists
for exactly one documented scenario (from `docs/PHASE_1_SCHEMA_DESIGN.md` §6): a reorg where the
same transaction is later re-included under an **unchanged `event_key`** (same `chain_id`,
`tx_hash`, `log_index`, `wallet_address`, `event_type` — the natural key literally doesn't
change). The reconciler's job in that case is to flip the existing row back to `PENDING` and let
it re-earn `POSTED` through the normal confirmation-depth wait — not insert a second row
(`event_key` is `UNIQUE`, so a second row for the same event is impossible by construction
anyway). `REVERSED → POSTED` directly is **not** allowed — recovery must go through `PENDING`
again.

This is not a general "unreverse" backdoor: it's a specific, narrow, already-documented
scenario, and it's the only place in any of the three transition tables where a state that
otherwise has zero valid intent-level analogue (a terminal state resuming) is permitted.

---

## 8. Concurrency and idempotency

Full reasoning is in the header comment of `apply.ts`; summary:

- Every transition is one **conditional `UPDATE ... WHERE id = $1 AND status = $2`** — not
  read-then-write with an in-memory lock. Postgres's row-level locking makes the
  compare-and-swap atomic on its own.
- **Idempotent**: calling `transitionAttempt(id, 'CONFIRMED')` twice — the second call sees
  `from === to` and returns `{ changed: false }` without attempting a write or throwing.
- **Concurrent, same target**: two callers racing to both set the same row to the same new
  status — the loser's conditional `UPDATE` affects zero rows; this module re-reads, sees the
  row already matches what was requested, and reports success (`changed: false` or `true`
  depending on who technically wrote it — either way, no error, no corruption).
- **Concurrent, different targets**: two callers racing to move the same row to two *different*,
  individually-valid next states — exactly one wins the write. The loser gets a distinct,
  explicit `ConcurrentTransitionConflictError` (carrying both what it asked for and what
  actually happened) rather than either a silent no-op or a misleading success. This is
  deliberately **not** swallowed — calling code (a future reconciler) needs to know a race
  happened and decide what to do, rather than this module guessing on its behalf.
- Both concurrency behaviors are exercised for real in `apply.test.ts` using a fake client with
  genuine conditional-update semantics and an injectable "race hook" that mutates the
  underlying row between this module's read and its write — not just asserted against a mock's
  canned return value.

---

## 9. What's actually wired up in Phase 2 (and what isn't)

**Is:**
- `server/transactionStateMachine/{types,transitions,apply,index}.ts` — the module itself.
- Two migrations refining the Phase 1 schema per the requested clarifications:
  `20260823070000_phase2_token_identity_and_notification_key.sql`.

**Is not:**
- No feature (Pay, Receive, Swap, Multichain Transfer/Claim, BulkPay, ChatPay, P2P) calls
  `transitionIntent`/`transitionAttempt`/`transitionLedgerEvent` yet.
- The indexer, `wallet-key`, `swap-proxy`, and `claim-worker` are untouched.
- Nothing creates `transaction_intents`/`transaction_attempts`/`ledger_events` rows yet — the
  state machine has valid transitions to apply *to* rows, but nothing in this phase inserts the
  first row of any of them. That's Phase 6+ (Pay) and onward, one feature at a time.

**A follow-up that was open in Phase 2 and is now resolved:** see
`docs/TRANSACTION_SERVICE_BOUNDARY.md` for the architecture decision record on where this module
lives, who may import it, and how `api/` and `supabase/functions/` are each expected to consume
it. As part of that decision, this module was physically moved from `src/lib/transactionStateMachine/`
(Vite/browser-bundled) to `server/transactionStateMachine/` (outside the Vite build root and the
`@` alias entirely) — no logic changed, only location, plus a dedicated `server/tsconfig.json`
and a `npm run typecheck:server` script mirroring the existing `api/tsconfig.json` pattern.

---

## 10. Failure taxonomy (state-machine-level, not feature-level)

This module throws exactly three error types, all defined in `apply.ts`/`types.ts`:

| Error | When |
|---|---|
| `InvalidTransitionError` | The requested `to` is not reachable from the actual `from` (whether read optimistically or discovered at write time) |
| `TransitionTargetNotFoundError` | No row exists for the given id |
| `ConcurrentTransitionConflictError` | A race was lost to a *different* valid transition than the one requested |

Feature-level failure codes (`INVALID_RECIPIENT`, `INSUFFICIENT_BALANCE`, `SLIPPAGE_EXCEEDED`,
etc., from the original brief's Phase 7/9 lists) are out of scope for this module — those live
in `transaction_intents.failure_code`/`failure_message` and `transaction_attempts.failure_code`/
`failure_message` (added in Phase 1), populated by whichever feature phase actually calls
`transitionIntent`/`transitionAttempt` with a `FAILED`/`REVERTED`/etc. target and its own
`extraFields`. This module validates *state shape*, not *business reason*.

---

## 11. Examples per feature (illustrative — no feature is wired up yet)

- **Pay**: intent `DRAFT→REVIEWED→AUTHORIZING→SUBMITTED→CONFIRMED`; one attempt
  `CREATED→BROADCASTING→SUBMITTED→CONFIRMING→CONFIRMED`; one `DEBIT` ledger event (sender) and
  one `CREDIT` ledger event (recipient), each `PENDING→POSTED`.
- **Swap**: one intent; one attempt; two ledger events (`SWAP_DEBIT` then `SWAP_CREDIT`) on the
  same wallet. An RPC timeout after the swap broadcasts is exactly the `SUBMITTED → UNKNOWN` case
  in §4 — the intent must not show `FAILED` while `UNKNOWN`.
- **CCTP (Multichain Transfer/Claim)**: one intent, but potentially **two** attempts on two
  different `chain_id`s (burn attempt, mint attempt) — this is exactly why attempts are their
  own table keyed by `intent_id`, not a 1:1 column on the intent.
  `BRIDGE_BURN` then `BRIDGE_MINT` ledger events.
- **Unified Balance**: intent with two attempts (deposit, spend), matching Phase 1's
  `UB_DEPOSIT`/`UB_SPEND` ledger event types — see `docs/PHASE_1_SCHEMA_DESIGN.md` §13.1 for why
  both are `direction = 'debit'` from the payer's perspective.
- **BulkPay**: one intent, one attempt (a single Multicall3 transaction), one `DEBIT` ledger
  event (payer) and N `CREDIT` ledger events (one per recipient) once that single attempt
  confirms — the "replacement" and "UNKNOWN" mechanics are identical to Pay's, just with more
  ledger events fanning out from the one attempt.
- **P2P**: trade state and escrow-transaction state are explicitly kept separate per the
  original brief (Phase 13) — an escrow deposit/release/refund would each be its own intent using
  this same module, but the P2P *trade* status (`CREATED`/`ESCROW_FUNDED`/.../`COMPLETED`) is a
  distinct state machine outside this module's scope, not decided in Phase 2.

---

## 12. Change budget

Files changed in Phase 2 (as originally implemented):

- `server/transactionStateMachine/types.ts` (new — originally created under `src/lib/`, moved; see §9)
- `server/transactionStateMachine/transitions.ts` (new — moved, see §9)
- `server/transactionStateMachine/apply.ts` (new — moved, see §9)
- `server/transactionStateMachine/index.ts` (new — moved, see §9)
- `server/transactionStateMachine/transitions.test.ts` (new — moved, see §9)
- `server/transactionStateMachine/apply.test.ts` (new — moved, see §9)
- `supabase/migrations/20260823070000_phase2_token_identity_and_notification_key.sql` (new)
- `docs/PHASE_1_SCHEMA_DESIGN.md` (extended — §13/§14, the three requested clarifications)
- `docs/TRANSACTION_STATE_MACHINE.md` (this file, new)

Files changed in the follow-up service-boundary pass (see `docs/TRANSACTION_SERVICE_BOUNDARY.md`):

- `server/transactionStateMachine/*` moved from `src/lib/transactionStateMachine/*` (no logic changed)
- `server/tsconfig.json` (new — mirrors `api/tsconfig.json`'s isolation pattern)
- `vitest.config.ts` (extended `include` to also pick up `server/**/*.test.ts`)
- `package.json` (added `typecheck:server` script, mirroring how `api/` is typechecked separately from the root `src/` project)
- `docs/TRANSACTION_SERVICE_BOUNDARY.md` (new — the ADR)

5 production source files (4 module files + 1 migration) plus 2 test files and 2 doc files in
the original Phase 2 pass — within the requested ~5–8 production-file budget. No unrelated file
touched. The follow-up pass touches only location/config, not implementation logic.
