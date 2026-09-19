# Ledger Canonical Event Design

Status: **design/audit only**. No migration, no production code. This document defines how raw
`chain_events` (Phase 3, already live) become canonical `ledger_events` (schema already exists
from Phase 1, currently unpopulated by anything) via a new component — the **Ledger
Interpreter** — without Activity, Balance, or Notifications ever being authoritative.

This is not a green-field design. It is the direct synthesis of everything already established:
Phase 1's `ledger_events`/`transaction_intents`/`transaction_attempts` schema, Phase 2's state
machine, Phase 3's `chain_events` identity fix and real-state audit, and the Activity Writer /
Claim-Recovery audits' concrete evidence of exactly which raw events get misclassified today and
why.

---

## 1. The core problem this solves

Today, "is this Transfer a financial fact worth recording, and what does it mean" is answered
**after the fact, per-writer, by guessing** — `claim-recovery-scan`'s `existsActivityForTxHash`
poll, `compare.ts`'s `KNOWN_INTERNAL_CONTRACTS` sender exclusion, `activity-consumer`'s
zero-address-sender skip. Each of these is a real, evidenced, but *partial* answer to the same
underlying question, arrived at independently in three different files with three different
techniques and three different blind spots (the traced EURC duplicate is exactly one of those
blind spots surfacing).

The Ledger Interpreter's job is to answer that question **once, centrally, deterministically**,
and to be the **only** thing allowed to create a `ledger_events` row. Nothing downstream
(Activity, Balance, Notifications) gets to reinterpret a raw chain fact — they only ever project
what the interpreter already decided.

---

## 2. Primary classification mechanism: transaction_intent correlation, not sender guessing

This is the single most important design decision in this document, and it directly answers the
brief's "do not rely solely on token Transfer sender/recipient" requirement.

**Primary signal**: `chain_events.tx_hash` -> `transaction_attempts.tx_hash` -> `transaction_intents.feature`.

Once a feature creates a `transaction_intents` row before broadcasting (the target architecture
from Phase 6 onward), every attempt it makes carries a `tx_hash` once broadcast, and every
`chain_events` row the indexer later observes for that `tx_hash` can be joined straight back to
`transaction_intents.feature`. This is authoritative, not a heuristic: the app itself classified
the transaction as a swap by creating a `feature='swap'` intent before ever broadcasting it. A
Transfer log whose `tx_hash` matches a `feature='swap'` intent's attempt is a swap leg, full
stop — no sender-address guessing required.

**Secondary/fallback signal**: `KNOWN_INTERNAL_CONTRACTS` sender-address classification (already
built, `supabase/functions/_shared/knownInternalContracts.ts`), used **only** when no
`transaction_intent` correlation exists for a given `tx_hash`. This is necessarily the case for
every feature that hasn't migrated to create intents yet (as of this design, that's every
feature — Phase 6+ is what starts populating `transaction_intents`). During that transition
window, the Ledger Interpreter falls back to exactly the sender-based reasoning
`claim-recovery-scan`'s new classification step and `compare.ts`'s `KNOWN_INTERNAL_CONTRACTS`
already use — narrower and less reliable than intent correlation (it tells you "this came from a
swap router," not "this came from *this specific* swap"), but real and already proven in
production.

**What this means concretely**: the Ledger Interpreter gets more precise over time as each
feature migrates to create real intents, without needing a rewrite — the fallback path is not a
stopgap that gets deleted later, it's a permanent secondary signal for the (hopefully shrinking)
set of cases where no intent exists (a genuinely external deposit has no intent at all, and
never will — that's the correct, permanent case for the fallback path to keep handling).

**Third signal, feature-specific**: for P2P specifically, sender-address classification alone
cannot distinguish `ESCROW_RELEASE` from `ESCROW_REFUND` — both are "Transfer FROM the escrow
contract." Disambiguating requires reading `p2p_trades`' own state (which wallet is buyer vs.
seller, and whether the trade completed vs. was refunded). This is a real, larger dependency
than the other features need, and is called out explicitly in §9 and §14 — the Ledger
Interpreter cannot be purely chain-events-driven for P2P; it needs a narrow, read-only view into
`p2p_trades`.

---

## 3. Financial fact vs. implementation event — the general rule

A raw chain event is a **financial fact** (produces a `ledger_events` row) if and only if it
represents an actual change in a wallet's economic position that the app should show the user
and count in their history. It is an **implementation event** (produces nothing) if it's
plumbing — a message-passing log, an internal rebalancing transfer, a contract's own bookkeeping
— that a user never needs to see and that, if surfaced, would either double-count a movement
already captured elsewhere or show the user something meaningless.

Applied to the brief's own examples:

| Raw event | Financial fact? | Why |
|---|---|---|
| Swap output Transfer | Yes — but as `SWAP_CREDIT`, never generic `CREDIT` | Real money arrived; the label must reflect why, resolved via §2's correlation, not left generic |
| CCTP `MessageReceived` (Arc MessageTransmitter) | No | Message-passing plumbing Circle's protocol requires; the actual mint is what moves money, this log doesn't |
| CCTP destination mint (USDC Transfer, `from = address(0)`) | Yes — as `BRIDGE_MINT`, exactly once | The real credit; must never also become a generic `CREDIT` (§8) |
| BulkPay Transfer (per recipient) | Yes — as `CREDIT`, one event per recipient, per log | Real money, real recipient, must not collapse across recipients (§6) |
| P2P escrow deposit | Yes — as `ESCROW_LOCK`, not plain `DEBIT` | Money left the trader's spendable balance, but into escrow, not to another user — a different economic meaning than a payment |
| P2P escrow release/refund | Yes — as `ESCROW_RELEASE`/`ESCROW_REFUND` | Real money movement, but the label must distinguish "trade completed" from "trade fell through" |
| UB internal rebalancing (if any exists inside Circle's UB implementation) | No, if purely internal to UB's own infrastructure | Not a MeshPort user's wallet gaining or losing anything — see §7.3 |

---

## 4. Amount model

Exactly as already established and enforced at the schema level in Phase 1
(`transaction_intents`, `ledger_events` both already have this): `amount_atomic numeric(78,0)`,
`decimals integer`, `token_address text`, `is_native boolean` (Phase 2's addendum migration,
with the enforced `CHECK (is_native = true OR token_address IS NOT NULL)` constraint). Nothing
in this design changes that model — it's inherited as-is. No floating-point amount is ever the
canonical value — this was already true of the schema before this document; restated here
because the Ledger Interpreter is the code that will actually populate these fields for the
first time, so it's the enforcement point that matters going forward.

---

## 5. Identity — deterministic ledger event keys per feature

Phase 1 already defined the general shape (`docs/PHASE_1_SCHEMA_DESIGN.md` §6): for log-derived
events, `event_key = "{chain_id}:{tx_hash}:{log_index}:{wallet_address}:{event_type}"`. This
document confirms that shape is sufficient for every one of the 11 features **once `event_type`
correctly reflects the semantic classification from §2**, not a generic type — which is exactly
why getting §2 right matters for identity, not just for labeling: two ledger events with the
same `(chain_id, tx_hash, log_index, wallet_address)` but different `event_type` (say, one
correctly `SWAP_CREDIT` and one incorrectly `CREDIT` because classification failed) would NOT
collide under this key — meaning a classification bug can silently produce a duplicate rather
than being caught by the identity constraint. This is a real, inherent property of using
`event_type` as part of the key rather than a limitation introduced here — noted as a risk in
§15, not solved by tightening the key (an event's meaning legitimately can't be known before
it's classified, so the key can't be computed independently of classification).

**BulkPay identity, specifically** (the brief's explicit "one tx -> many recipients -> many
ledger events, without collapsing" requirement): each Multicall3-driven Transfer log has its own
`log_index`, already correctly captured end-to-end since the Phase 3 `chain_events` identity fix
(verified against a real reproduction — a 3-recipient batch that previously collapsed to a
single row now produces 3 distinct `chain_events` rows). The Ledger Interpreter inherits this
directly: for N Transfer logs, N distinct `chain_events.log_index` values feed N distinct
`ledger_events.event_key` values — no new identity work needed, Phase 3 already solved the hard
part. See §6 for what the interpreter adds on top (the DEBIT/CREDIT pairing per log).

---

## 6. Multi-movement transactions and atomicity (BulkPay as the driving case)

**Per-log-index, not per-transaction, is the atomic processing unit.** For a BulkPay transaction
with N Transfer logs: the interpreter processes each log independently, producing two
`ledger_events` per log — one `DEBIT` for the payer's wallet, one `CREDIT` for that log's
recipient wallet — both keyed off that log's own `log_index`. This mirrors how a single ordinary
Pay transaction is already modeled (§7.1): one Transfer log, one DEBIT + one CREDIT pair, just
generalized to N logs instead of one.

**If processing crashes after 40/100 logs**: the 40 already-committed pairs are unaffected (each
has its own `event_key`, already `POSTED` or `PENDING` independently) — the next interpreter
pass simply resumes from log 41, since `event_key` uniqueness means re-processing logs 1-40 is a
safe no-op (upsert-ignore-duplicates, identical to every other idempotent writer already proven
in this codebase). This is a deliberate design choice, not an oversight: requiring all 100 to
commit atomically as one unit would mean a single malformed log (or a crash) blocks the other 99
forever — exactly the class of bug the Phase 3 `chain_events` identity fix already eliminated at
the layer below this one. The Ledger Interpreter does not reintroduce that failure mode one
layer up.

**Swap's two legs** (SWAP_DEBIT + SWAP_CREDIT) are the one case where the two `ledger_events`
belong to the same wallet and arguably should be thought of as one economic movement for
projection purposes (§10) — but they are still two independent rows at the ledger layer (they
may even be on different token contracts, hence different `log_index` values, and could in
principle be observed by the indexer at slightly different times) — atomicity at the ledger
layer is still per-event, not per-intent; grouping happens at the projection layer, not by
merging ledger rows.

---

## 7. Feature-by-feature semantics (summary — full table in docs/LEDGER_FEATURE_MAPPING.md)

### 7.1 Pay / Receive
One Transfer -> one `DEBIT` (sender wallet) + one `CREDIT` (recipient wallet). "Receive" is not
a distinct ledger concept — it's the recipient-side `CREDIT` row of the same event, exactly as
already established in Phase 2's docs. The recipient side typically has no
`transaction_intent_id` (they didn't initiate anything) — `ledger_events.transaction_intent_id`
is nullable specifically for this reason (already true in the Phase 1 schema).

### 7.2 Swap
One Transfer (tokenIn leaves) -> `SWAP_DEBIT`. One Transfer (tokenOut arrives, possibly a
different log entirely, different contract) -> `SWAP_CREDIT`. Both correlate to the same
`transaction_intent` (`feature='swap'`) once that intent exists (§2's primary path); until then,
the output leg is protected from becoming generic `CREDIT` by the sender-address fallback
(`KNOWN_INTERNAL_CONTRACTS` already includes the Kit Adapter router — the exact address from the
traced EURC case). This is the direct architectural fix for the EURC duplicate: once the Ledger
Interpreter owns this classification centrally, `claim-recovery-scan`'s and
`activity-consumer`'s independent, partial answers to the same question become redundant safety
nets rather than the only line of defense — though neither is removed by this design (that's a
later migration decision, explicitly out of scope here).

### 7.3 Multichain Transfer — Unified Balance
`UB_DEPOSIT` (payer's source-chain wallet -> UB, `DEBIT` direction) then `UB_SPEND` (UB ->
destination payout, also `DEBIT` direction from the payer's perspective, per Phase 1's own
reasoning — UB has no credit leg of its own). The destination-chain arrival for whoever receives
the payout is a normal `CREDIT` (§7.1-shaped), correlated to a different intent (the recipient's
own, if any) or none. Any UB-internal rebalancing transfer that never reaches or leaves a
MeshPort user's wallet is an implementation event — produces nothing (§3).

### 7.4 Multichain Transfer — CCTP V2
Source burn -> `BRIDGE_BURN` (`DEBIT`, on the source chain). Destination mint -> `BRIDGE_MINT`
(`CREDIT`, on Arc). The intermediate `MessageReceived` log (used only to resolve which source
chain a mint came from, per `resolveSourceChain`'s existing, unchanged logic) is an
implementation event — never becomes a ledger row itself.

### 7.5 Multichain Claim — CCTP V2
Same underlying on-chain event as 7.4's destination mint — a claim is the user-initiated
recovery of a burn the app is separately tracking via `claims`, not a different on-chain event.
The critical rule (§8): this mint produces exactly one ledger event (`BRIDGE_MINT`/`CREDIT`),
correlated via `claims.transaction_intent_id` (already a nullable link column from Phase 1) —
never both a generic-detection `CREDIT` and a separate claim-specific credit.

### 7.6 BulkPay — Multicall3
Per §6: N Transfer logs -> 2N `ledger_events` (N `DEBIT` for the payer, N `CREDIT` for N
recipients), all correlated to one `transaction_intent` (`feature='bulkpay'`) for the payer's
side; each recipient's `CREDIT` has no intent of its own (§7.1's pattern, generalized).

### 7.7 ChatPay
Identical ledger shape to Pay (§7.1) — ChatPay reuses the Payment Engine, per the original
architecture brief. The only difference is metadata (a chat-message reference lives in
`transaction_intents.metadata` or a dedicated column, not a new `event_type`).

### 7.8 P2P escrow deposit
`ESCROW_LOCK` (`DEBIT`) — funds leave the trader's spendable wallet into the escrow contract.
Not a payment to anyone; a distinct economic state (funds committed, not yet resolved).

### 7.9 P2P escrow release
`ESCROW_RELEASE` (`CREDIT`) — funds leave the escrow contract to the buyer, trade completed.
Sender is the escrow contract address (a `KNOWN_INTERNAL_CONTRACTS`-style entry once configured,
per the Claim-Recovery fix's `extra` mechanism) — never generic `CREDIT`. Disambiguating from
refund requires `p2p_trades` state (§2's third signal) — the raw Transfer alone cannot tell
release from refund.

### 7.10 P2P escrow refund
`ESCROW_REFUND` (`CREDIT`) — funds return to the original locker, trade did not complete. Same
sender-contract pattern as release; same disambiguation dependency on `p2p_trades`.

Full per-feature table (raw events, identity, projection, notification, failure/reorg behavior)
is in `docs/LEDGER_FEATURE_MAPPING.md`, per your requested format.

---

## 8. Preventing CCTP mint double-representation (explicit)

This is called out as its own section because the brief explicitly requires it and because the
codebase already has three independent places that currently apply a version of the same rule
(worth naming so the Ledger Interpreter doesn't become a fourth divergent copy):

1. `scanner.ts`'s ERC-20/native-log scan explicitly skips `MINT_FROM_TOPIC` (zero-address
   sender) — "mint: claim-worker owns."
2. `activity-consumer/decide.ts` explicitly skips zero-address-sender events with the reason
   string `'zero-address sender (CCTP mint) — owned by claim-worker'`.
3. `claim-recovery-scan`'s own `isMint` branch routes zero-address transfers through claim
   matching, never through `recordExternalReceive`.

**The Ledger Interpreter's rule, unifying these three**: any chain event whose sender is
`address(0)` is never eligible for the generic `CREDIT` classification path at all — full stop,
before §2's correlation logic even runs. It is routed to a dedicated CCTP-mint interpretation
path that (a) looks up a matching `claims` row (via `destination_tx_hash` or the
`transaction_intent_id` link), (b) if found, produces exactly one `BRIDGE_MINT` event correlated
to that claim/intent, (c) if no matching claim exists at all (a genuinely untracked mint — the
exact scenario `claim-recovery-scan`'s own "fully untracked mint" branch already handles by
creating a fresh `claims` row), the interpreter still produces exactly one `BRIDGE_MINT` event,
now correlated to the newly created claim row instead. Never both a generic path and a claim
path — the address(0) check happens first and is exclusive.

---

## 9. P2P's extra dependency (explicit callout)

Every other feature's classification in §2 can be resolved from `chain_events` +
`transaction_intents` alone. P2P escrow release vs. refund cannot — both are "Transfer FROM the
escrow contract," and only `p2p_trades`' own recorded outcome (completed vs.
cancelled/refunded) distinguishes them. This means the Ledger Interpreter needs read-only access
to `p2p_trades` specifically for this one classification decision — a real, larger surface than
any other feature requires, flagged here rather than glossed over. (`p2p-release-reconcile`,
confirmed in the Claim-Recovery audit, already reads `P2P_ESCROW_CONTRACT`/`_LEGACY` and manages
this exact domain server-side — the Ledger Interpreter's P2P path likely needs to run adjacent
to or consult that same worker's understanding of trade state, not reinvent it.)

---

## 10. Activity projection — grouping rule

**Default: one `ledger_event` -> one Activity row.** Exception, explicit: Swap's two legs
(`SWAP_DEBIT` + `SWAP_CREDIT`), on the same wallet, same `transaction_intent_id`, project to ONE
Activity row — matching the existing, correct UI pattern already described in the original
architecture brief ("100 USDC -> 98.31 EURC" as one entry, not two). This is a projection-layer
decision, not a ledger-layer merge (§6) — the two ledger rows remain independently identifiable
and idempotent; only the Activity projection groups them by `transaction_intent_id` when
building the user-facing row.

Pay's DEBIT/CREDIT pair does not group — they belong to two different wallets (two different
users' histories), so they correctly remain two separate Activity rows, one per wallet, exactly
as today.

The general rule: group by `transaction_intent_id` only within the same `wallet_address`; never
group across wallets (that would improperly merge two different users' financial histories into
one).

## 11. Balance — chain-derived, not ledger-summed

**Authoritative balance remains chain-derived** (a direct RPC/balance read), exactly as it is
today (confirmed multiple times across the Phase 0/3 audits — no writer in this codebase sums
`activity` or any ledger-shaped table to produce a balance figure). This design does not change
that. `ledger_events` may, as later optimization work, feed a fast cache/projection for snappier
UI display (avoiding a live RPC round-trip on every balance render) — but that cache must be
periodically reconciled against the chain-derived source of truth and must never be treated as
authoritative on its own. Activity must never mutate balance in any form — already true today
(confirmed: zero balance writes found in any of the 16 cataloged Activity writers), and
unchanged by this design.

## 12. Notifications — deduplicated by economic event, not by row

`notification_events` (Phase 1 schema, unpopulated so far) should be created from `ledger_events`
using the same grouping rule as Activity (§10): one notification per grouped economic event, not
per raw ledger row. A swap produces one "Swap Complete" notification, not a "Swap" and a separate
"Payment Received" (the exact duplicate-notification symptom already documented in the Activity
Writer audit for the EURC case). Deterministic dedup key: `event_key` prefixed/scoped by
`transaction_intent_id` where one exists (matching Phase 1's original
`payment_confirmed:<transaction_intent_id>` example), falling back to the ledger event's own
`event_key` when no intent exists (external deposits).

---

## 13. Failure model — how the four layers compose

```
transaction_intent (Phase 2 state machine)
  DRAFT -> REVIEWED -> AUTHORIZING -> SUBMITTED -> CONFIRMED
                                          -> FAILED (broadcast never succeeded)

transaction_attempt (Phase 2 state machine)
  CREATED -> BROADCASTING -> SUBMITTED -> CONFIRMING -> CONFIRMED
                                  -> UNKNOWN -> CONFIRMED / REVERTED / DROPPED

chain_event (Phase 3, already live)
  pending -> confirmed
      -> reorged   (pending only -- confirmed events currently have no reorg path, Phase 3's
                     own documented gap, inherited here unchanged)

ledger_event (Phase 1 schema, this design populates it)
  PENDING -> POSTED
      -> REVERSED (from either PENDING or POSTED, on a chain_event reorg)
  REVERSED -> PENDING is the one documented recovery exception (Phase 1 §6 / Phase 2 §7), for a
              re-included same-event_key transaction
```

**How they connect**: a `ledger_event` is only ever created from a `chain_event` that has
reached `status = 'confirmed'` (mirroring `activity-consumer`'s own already-correct
confirmed-only gate) — never from `pending`. Its initial `settlement_status` is `PENDING`
(Phase 1's own reasoning: promoted to `POSTED` only once past the relevant chain's
confirmation-depth policy, which for Arc's `confirmationDepth=0` is effectively immediate).
`REVERTED`/`DROPPED` attempts never produce a `ledger_event` at all — no financial fact exists
for a transaction that didn't succeed. `SUBMITTED_UNKNOWN` (the derived, non-stored display
state from Phase 2) has no ledger representation whatsoever — by design, since it means "we
don't yet know," and the ledger only ever records facts that are known.

---

## 14. What this design deliberately does not decide

- The exact module/file structure of the "Ledger Interpreter" (a new Edge Function? Part of
  `activity-consumer`'s eventual successor? A shared library called from multiple places?) — an
  implementation decision for the next phase, not a design-only one.
- Whether `activity-consumer`, `claim-recovery-scan`'s generic-receive branches, or
  `deposit-scan-all` reconcile are removed, modified, or left running alongside the new ledger
  path during a transition period — that's the migration/cutover plan, explicitly out of scope
  for this design-only checkpoint (and explicitly forbidden to implement this pass).
- The precise mechanism for the Ledger Interpreter to read `p2p_trades` (§9) — direct query vs.
  a small shared helper vs. consulting `p2p-release-reconcile`'s own logic — a P2P-specific
  implementation decision for whichever phase actually builds the P2P ledger path.
