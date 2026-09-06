# Ledger Schema Gap Audit

Status: **audit/design only**. No migration written, no production code touched, no
`ledger_events` row created. Every finding below is either quoted from the actual migration
files, queried directly from live production data, or explicitly marked as unverified with the
exact missing evidence named — nothing is filled in by assumption.

**Baseline correction, stated up front because it matters for everything below**: `list_migrations`
against the live `MeshPort` project confirms **only the Phase 3 `chain_events` migration is
actually applied to production**. Phase 1 (`transaction_intents`/`transaction_attempts`/
`ledger_events`/`notification_events`) and Phase 2 (token-identity/notification-key fixes) exist
**only as written, unapplied migration files** in this repository — confirmed directly:
`information_schema.tables` shows zero of those four tables exist live. This audit evaluates the
schema **as designed in those migration files** (per your instruction to use the approved design
as baseline), not a live table — every finding is phrased accordingly.

---

## 1. Raw event identity — CRITICAL finding, real gap confirmed

**Read directly from `supabase/migrations/20260823060000_phase1_canonical_transaction_model.sql`
lines 137-176**: `ledger_events`' only uniqueness constraint is
`CONSTRAINT ledger_events_event_key_key UNIQUE (event_key)`, where `event_key` is a single `text`
column populated by application code as
`"{chain_id}:{tx_hash}:{log_index}:{wallet_address}:{event_type}"` (per the column's own
`COMMENT`). **`event_type` is part of the unique string, not a separate constraint column.**

**This confirms the exact failure mode the task describes is real, not hypothetical**: two rows
for the identical raw movement — same `chain_id`, `tx_hash`, `log_index`, `wallet_address` — but
different `event_type` values (`SWAP_CREDIT` vs. `CREDIT`) produce two *different* `event_key`
strings. The `UNIQUE (event_key)` constraint has no way to see these as conflicting, because
textually they aren't. A classification bug (the interpreter disagreeing with itself across two
passes, or a race between the primary intent-correlation path and the sender-address fallback
disagreeing) could insert both rows, and the schema would accept both silently.

**Recommended constraint** (per your explicit instruction not to make `(chain_id, tx_hash,
log_index)` alone unique, since one log legitimately produces a DEBIT row and a CREDIT row for
two *different* wallets):

```sql
CREATE UNIQUE INDEX ledger_events_raw_movement_key
  ON public.ledger_events (chain_id, tx_hash, COALESCE(log_index, -1), wallet_address)
  WHERE tx_hash IS NOT NULL;
```

- Includes `wallet_address` so the legitimate DEBIT (sender)/CREDIT (recipient) pair from one
  log is unaffected — they differ on `wallet_address`, so both rows remain permitted.
- Deliberately excludes `event_type` — this is the whole point. This index catches "the same
  wallet's same raw leg, interpreted twice," regardless of what the second interpretation called
  it.
- `COALESCE(log_index, -1)` mirrors the exact pattern already proven correct and load-tested in
  the Phase 3 `chain_events` migration (`chain_events_dedup_idx`), for the identical reason: the
  native top-level-transfer path has no log at all, so `log_index` is legitimately `NULL`, and
  Postgres's default "every NULL is distinct" behavior would otherwise silently defeat this
  guard for exactly that path.
- Checked for a legitimate case where one wallet needs two rows for the same raw leg (e.g. could
  a wallet ever need to be BOTH debited and credited by the same single log?) — no: a single
  ERC-20 `Transfer` has exactly one `from` and one `to`; a `from == to` self-transfer is already
  explicitly excluded everywhere in the existing scanner/recovery code (`"self-transfer, not a
  real incoming payment"`, present in `scanner.ts`, `claim-recovery-scan`, consistently). So this
  index has no known legitimate collision case to guard against with an exception.

**This is an additive index** on the not-yet-applied Phase 1 table definition — no data exists
yet to violate it, so it can be folded directly into the (still unapplied) Phase 1 migration
rather than requiring a separate follow-up migration. Listed as its own migration below (§12A)
in case the two are applied separately.

---

## 2. BulkPay / Multicall3 atomicity — mostly already answered by existing evidence, one real gap found

- **Each `log_index` independently represented**: confirmed, Phase 3's fix + its own
  reproduction test (a 3-recipient BulkPay-shaped batch that previously collapsed to one row now
  produces 3 distinct `chain_events` rows).
- **Each recipient gets an independent ledger credit, payer gets corresponding debit(s)**:
  supported by the schema as designed — nothing prevents N independent `(DEBIT, CREDIT)` pairs
  keyed by `log_index`, per `docs/LEDGER_CANONICAL_EVENT_DESIGN.md` §6's design (unchanged by
  this audit).
- **Retries idempotent, resumable after a crash**: yes, via `event_key`/the new raw-movement
  index (§1) — both are `UNIQUE` and upsert-ignore-duplicates is already the proven pattern used
  by every writer in this codebase.
- **Reverted Multicall3 transactions create zero ledger events — is a receipt-status check
  required?** Answered with real EVM semantics, not a guess: **a reverted transaction emits zero
  logs, full stop** — this is fundamental EVM behavior, not application logic. `scanner.ts`'s
  `eth_getLogs`-based scan (which is what would ever see a Multicall3/BulkPay `Transfer` log at
  all) **cannot** return logs from a reverted transaction — there is nothing there to
  misinterpret. **No explicit receipt-status check is required for the log-derived paths** (ERC-20
  scan, native-transfer-log scan) — the guarantee is structural, at the protocol level, not
  something the interpreter needs to verify itself.
- **New, real gap found, distinct from BulkPay specifically**: `scanner.ts`'s **native
  top-level-transfer scan** (`eth_getBlockByNumber` reading `tx.value`/`tx.to` directly from the
  block's transaction list, not from logs) does **not** check `receipt.status` anywhere —
  confirmed by re-reading the relevant loop. `tx.value`/`tx.to` are properties of the *signed
  transaction request*, set before execution, and remain populated even if the transaction's
  on-chain execution reverted (e.g. a call to a contract that sends native value as part of a
  call that ultimately reverts). For a plain EOA-to-EOA native transfer this is moot (such a
  transfer essentially cannot "revert" in the traditional sense), but for `tx.to` being a
  contract, this is a real, previously-unflagged gap. **Does not affect BulkPay** (Multicall3
  interactions go through the log-based ERC-20 path, not the native top-level path), but is a
  real answer to the general "must receipt status be checked" question the task asked, and is
  noted here as a **pre-existing indexer gap, not fixed in this audit** (fixing it would mean
  modifying the indexer, explicitly out of scope for this pass).

---

## 3. Real UB forensic audit — required, performed, **partially verified, partially unverified**

**What Unified Balance actually is, confirmed from source**: `src/lib/ubFundRecovery.ts`'s own
header comment states it plainly — UB is **Circle Gateway**, a third-party Circle product
accessed via `@circle-fin/app-kit`/`@circle-fin/adapter-ethers-v6`, not a MeshPort-built
mechanism. "Deposit-once/spend-anywhere" — confirmed independently in
`src/features/multichain/MultichainSendPage.tsx`'s own comments ("Circle Gateway (unified
balance) path... Gateway is a deposit-once/spend-anywhere model").

**Real data found and traced** (per your explicit instruction to trace at least one real
transaction if data exists): queried `activity` for `activity_type = 'withdraw'` — the type
`ubFundRecovery.ts`'s own comment says UB recovery uses — and found **3 real rows**, all
"recovery from a failed/incomplete UB spend" cases (not normal successful UB transfers — this
dataset has no confirmed-successful UB deposit+spend pair to trace, only failure-recovery
cases). Traced the most complete one:

| Field | Value |
|---|---|
| `init_tx_hash` (metadata) | `0x5f6b48fee3eec406ae4f41f3f5a3eb1445813e969d075f83d77c346b4f193be8` |
| `completed_tx_hash` (metadata) | `0x32cf03486a57631d741d8d994523614a14bf951e7323b3973e2de3bac87101e1` |
| `original_destination` | `Ethereum` |
| Wallet | `0x05d00ab7…64ee126e0` |
| Amount | 5 USDC |

Queried `chain_events` for all 5 real tx hashes across the 3 recovery rows: **only
`completed_tx_hash` `0x32cf0348…` was found** (the other `completed_tx_hash` and both
`init_tx_hash` values were not — explained below, not a mystery). The one found row:

```
event_type: deposit_detected, via: native-transfer-log
sender: 0x0077777d7eba4688bdef3e311b846f25870a19b9
recipient: 0x05d00ab7…64ee126e0 (the user's own Arc wallet)
status: confirmed
```

**Confirmed, concretely, not speculatively**: this sender address is **already the first entry
in the existing `KNOWN_INTERNAL_CONTRACTS` list** (`supabase/functions/_shared/
knownInternalContracts.ts`, inherited unchanged from `compare.ts`/`deposit-scan-all`/
`api/relay-rpc.js`'s `CIRCLE_CONTRACTS`). This means: **the one real UB-related on-chain event
this audit could actually observe would already be correctly excluded from generic
`CREDIT`/`RECEIVE` classification today**, by the existing sender-address fallback mechanism —
a genuine, evidence-based validation of §2's fallback design for at least this one case, not an
assumption.

**Why the other 4 hashes weren't found — explained, not unexplained**: the other
`completed_tx_hash` (the Sei-bound recovery) has `completed_at: 2026-08-01`, **before
`blockchain-indexer` was even deployed** (2026-08-08, confirmed in the Phase 3 audit) — the
indexer could not have seen it; it doesn't backfill from genesis (confirmed Phase 3, "cold start
begins at head, not genesis"). The `init_tx_hash` values were not found in `chain_events` at all
under any interpretation — **this is a genuine, unresolved gap**, not explained by timing alone,
since even the more recent recovery case (`created_at: 2026-08-23`, well after indexer
deployment) has an `init_tx_hash` that was never observed.

**What remains genuinely unverified — named exactly, per your instruction**:

1. **What the UB deposit leg (`init_tx_hash`, source Arc wallet → Gateway Wallet contract) looks
   like on-chain** — no `chain_events` row exists for any `init_tx_hash` in this dataset, so
   whether it's a native-transfer-log-shaped event (like the recovery completion turned out to
   be), an ERC-20-shaped event, or something the current scan doesn't watch at all, **cannot be
   confirmed from available evidence**.
2. **What a successful (non-recovery) UB spend/destination-credit looks like** — no successful
   UB transfer exists in this dataset at all, only failure-recovery cases. The design document's
   `UB_SPEND`/destination-`CREDIT` split (§7.3 of `LEDGER_CANONICAL_EVENT_DESIGN.md`) remains
   **unverified against real data**.
3. **Whether an internal settlement/rebalancing event exists inside Circle's Gateway
   infrastructure** — no evidence either confirms or refutes this. Not found in any code path
   inspected in this repository (which makes sense — if it's purely internal to Circle's own
   infrastructure, it would never be visible to MeshPort's code at all by construction, only
   inferable from Circle's own API responses, which were not inspected in this pass).

**Explicit statement, per your required phrasing**: **"UB mapping remains unverified"** for the
deposit leg and the successful-spend/destination-credit leg. The one verified fact — the
recovery-completion leg landing back on Arc is a native-USDC-shaped transfer from a
known-internal Circle contract address — is real and traced, but is the *failure-recovery* path,
not the primary `UB_DEPOSIT`/`UB_SPEND` lifecycle the design document speculates about.

---

## 4. P2P classifier interface — real schema evidence found, design refined (not just re-confirmed)

Read `p2p_trades`' actual live columns directly (`information_schema.columns`) rather than
assuming: `buyer_wallet`, `seller_wallet`, `status`, `tx_hash`, `released_at`, `dispute_status`,
`admin_frozen`, plus (confirmed via `p2pService.ts` source, not the schema alone) `p2p_offers`
carries its own separate `escrow_deposit_tx_hash` and `escrow_withdraw_tx_hash` columns.

**Real, load-bearing finding that changes the design document's original framing**: read the
exact write sites in `p2pService.ts` — `p2p_trades.tx_hash` is written **only** at
`status: 'completed'` time, with an explicit code comment confirming it: *"the trade row (t.tx_hash
is the RELEASE hash)"*. Separately, `p2p_offers.escrow_deposit_tx_hash` is written at deposit
time, and `escrow_withdraw_tx_hash` is written at cancellation (refund) time. **Each of the three
P2P actions (lock/release/refund) already writes its own, distinct tx_hash column** — this is
*more* precise than `LEDGER_CANONICAL_EVENT_DESIGN.md`'s original framing (§9), which assumed
disambiguation would require reading the *trade's current status* to decide release-vs-refund for
an ambiguous "Transfer from escrow" event. It doesn't need to: **the tx_hash itself already tells
you which action it was**, no status inference needed.

**Revised classifier contract** (design only, not implemented):

```
classifyP2PTransfer(chainEvent) -> ESCROW_LOCK | ESCROW_RELEASE | ESCROW_REFUND | UNRESOLVED

1. If chainEvent.tx_hash matches any p2p_offers.escrow_deposit_tx_hash -> ESCROW_LOCK
2. Else if chainEvent.tx_hash matches any p2p_trades.tx_hash (status='completed') -> ESCROW_RELEASE
3. Else if chainEvent.tx_hash matches any p2p_offers.escrow_withdraw_tx_hash -> ESCROW_REFUND
4. Else if chainEvent's sender is the configured P2P escrow contract (KNOWN_INTERNAL_CONTRACTS
   `extra`, per the Claim-Recovery fix) but matches none of the above -> UNRESOLVED, NOT generic CREDIT
5. Else (sender is not the escrow contract at all) -> NOT_P2P, continue normal classification
```

**Required DB reads**: `p2p_offers` (by `escrow_deposit_tx_hash`/`escrow_withdraw_tx_hash`),
`p2p_trades` (by `tx_hash`) — both read-only, both simple exact-match lookups by tx_hash, not a
broader "is this wallet the buyer or seller" contextual query as originally speculated. This is
a **smaller** dependency than `LEDGER_CANONICAL_EVENT_DESIGN.md` §9 originally described.

**Ownership checks**: none needed beyond the tx_hash match itself — these columns are only ever
written by trusted server-side code (`p2pService.ts`, `p2p-release-reconcile`), so a match is
inherently trustworthy.

**What happens when trade/offer state is missing** (step 4 above): **`UNRESOLVED`, not a silent
fallback to generic `CREDIT`.** This is the explicit "define the correct UNRESOLVED behavior
instead of guessing" the task requires. An `UNRESOLVED` classification should **not** create any
`ledger_events` row at all until resolved (e.g. by a later pass once the app's own write lands,
mirroring the exact TOCTOU-then-resolve pattern the Claim-Recovery fix and `existsActivityForTxHash`
already establish elsewhere) — never silently mis-file it as a generic receive, which is exactly
the class of bug this whole effort has been chasing since the EURC trace.

**Residual risk, named explicitly**: a timing race remains possible — the indexer could observe
the escrow Transfer before `p2pService.ts`'s own write to `escrow_deposit_tx_hash`/`tx_hash`/
`escrow_withdraw_tx_hash` lands, producing a transient `UNRESOLVED` that should self-heal once
those columns are populated. Same class of race already documented and partially mitigated
elsewhere in this codebase (the BulkPay/Claim-Recovery fixes) — not solved by this design pass,
correctly deferred to whichever phase implements the P2P interpreter path.

**Escrow contract address dependency**: confirmed again — still not configured in this
environment (no `P2P_ESCROW_CONTRACT` value verifiable, only the env var *name* confirmed to
exist and be read consistently across `p2p-release-reconcile` and the Claim-Recovery fix).

---

## 5. CCTP double-representation — schema supports it, correlation model confirmed

`claims.transaction_intent_id` (nullable, added in Phase 1's design, unapplied) is the intended
correlation path — a `BRIDGE_MINT` ledger event correlates to a `claims` row, never independently
to a generic detection. Cross-referenced against **live, currently-applied** schema: `claims`
table exists live (pre-dates Phase 1, confirmed in `list_migrations` — `20260702120000_create_claims`)
and already has `destination_tx_hash`, which is the real, already-proven join key
`claim-recovery-scan`/`claim-worker` use today to detect "already tracked" mints (`.eq('destination_tx_hash', txHash)`,
confirmed in the Claim-Recovery audit's exact trace). **The schema fully supports the intended
exclusivity rule** (§8 of `LEDGER_CANONICAL_EVENT_DESIGN.md`) using either `destination_tx_hash`
(already live) or `transaction_intent_id` (designed, not yet applied) — no schema gap found here.
The address(0)-first exclusivity rule itself (§8) is an interpreter-logic decision, not a schema
requirement, and needs no additional constraint beyond what's already designed.

---

## 6. Swap two-leg model — schema supports it, no gap found

`ledger_events.transaction_intent_id` (nullable FK to `transaction_intents`) already allows two
rows (`SWAP_DEBIT`, `SWAP_CREDIT`) to share one intent, same `wallet_address`, different
`token_address`/`log_index` — nothing in the Phase 1 design prevents this, and §1's new
raw-movement index doesn't either (different `log_index` values mean no collision between the
two legs). Activity grouping (merge two ledger rows into one UI row without merging the
underlying rows) is a **projection-layer** concern, not a schema one — `ledger_events` itself
needs no schema change to support it; the future Activity-projection code simply needs to query
`WHERE transaction_intent_id = X AND wallet_address = Y` and group in application logic. No gap.

---

## 7. Failure / reorg model — schema supports the full lifecycle, one pre-existing gap re-confirmed

Cross-checked the full `transaction_intents.status` / `transaction_attempts.status` /
`chain_events.status` / `ledger_events.settlement_status` enums against
`LEDGER_CANONICAL_EVENT_DESIGN.md` §13's diagram — every state named there
(`DRAFT`/`REVIEWED`/`AUTHORIZING`/`SUBMITTED`/`CONFIRMED`/`FAILED` for intents;
`CREATED`/`BROADCASTING`/`SUBMITTED`/`UNKNOWN`/`CONFIRMING`/`CONFIRMED`/`REVERTED`/`DROPPED`/`REPLACED`
for attempts; `pending`/`confirmed`/`reorged` for chain_events; `PENDING`/`POSTED`/`REVERSED` for
ledger_events) is present in the actual `CHECK` constraints of the respective migration files —
confirmed by direct re-read, not assumed. `SUBMITTED_UNKNOWN` is correctly **not** a stored
value anywhere (Phase 2's own design: derived, not persisted) — so there is no schema gap where
it could accidentally leak into a ledger row; the interpreter's own logic (never create a
`ledger_event` from anything but a `confirmed` `chain_event`) is what actually enforces "no
ledger event from an unknown-outcome broadcast," and that logic doesn't yet exist (nothing does)
— but the *schema* has no gap preventing it from being written correctly.

**Re-confirmed pre-existing gap** (already known from Phase 3, restated here for completeness
per the task's request to audit this lifecycle end-to-end): `chain_events.status` can only go
`pending -> reorged`, never `confirmed -> reorged` (Phase 3 `cursors.ts`'s `markEventsReorged`
only updates `WHERE status = 'pending'`). This means a `ledger_event` derived from a `confirmed`
chain event that somehow still gets reorged (only a live risk once a chain with nonzero
confirmation depth is enabled — inert for Arc today) has **no upstream signal to trigger its own
`POSTED -> REVERSED` transition** — the `ledger_events.settlement_status` state machine itself
supports `REVERSED` correctly (Phase 2 §7), but nothing would ever call it, because
`chain_events` itself never tells anyone a confirmed event reorged. **This is an indexer-layer
gap, not a ledger-schema gap** — restated, not newly discovered, and explicitly not fixed here
(modifying the indexer is out of scope for this pass).

---

## 8. Balance model — no schema change needed, confirms existing design

Nothing in the Phase 1/2/3 schema makes any table balance-authoritative, and this audit found no
reason to change that. Chain-derived balance (direct RPC read) remains authoritative; a future
`ledger_events`-derived cache is optional future work, explicitly not decided or built here, per
your instruction not to redesign balance in this phase.

---

## 9. Notification model — real gap found, smaller than §1's but real

`notification_events`' identity (Phase 1, unapplied) is `UNIQUE (wallet_address, event_key)`
(Phase 2's fix removed the redundant `user_id`-keyed index, per that phase's own audit). This
prevents a literal duplicate *notification row*, but — **exactly the same structural issue as
§1** — if the grouping/dedup logic that builds `event_key` for a notification is itself wrong
(e.g. builds a swap notification's key from `SWAP_CREDIT`'s `ledger_events.event_key` in one code
path and a separate, differently-keyed "Payment Received" notification from a same-transaction
but differently-classified event in another), **the schema cannot catch that** — two
legitimately-different `event_key` strings for what should have been one grouped notification
would both insert successfully. **This is not a table-identity gap** the way §1 is (there's no
"raw movement" analog for notifications the way there is for ledger events — a notification's
identity is inherently about the *grouped* economic event, not a raw chain movement) — so no
specific new index is recommended here. Instead: **the dedup correctness for notifications
entirely depends on the interpreter/projection layer building `event_key` correctly and
consistently from `transaction_intent_id` when one exists** (per
`LEDGER_CANONICAL_EVENT_DESIGN.md` §12) — this is an implementation-correctness requirement to
carry into the next phase, not a schema gap to fix now.

---

## 10. Idempotency — confirmed sufficient, no new finding beyond §1

`event_key UNIQUE` (ledger_events) and the equivalent constraints on `transaction_intents`
(`wallet_address, idempotency_key`), `transaction_attempts` (`chain_id, tx_hash` partial unique),
and `notification_events` (`wallet_address, event_key`) are all real, already-designed,
upsert-ignore-duplicates-compatible constraints — confirmed present in the migration files.
§1's new index is additive to this, not a replacement — `event_key` uniqueness still matters and
is unaffected.

---

## 11. FINAL SCHEMA GAP MATRIX

| Area | Current schema sufficient? | Evidence | Gap | Required change | Risk |
|---|---|---|---|---|---|
| Raw event identity | **No** | `event_key` includes `event_type`; direct read of the migration file | Same raw movement can get two rows under different `event_type` | Add `ledger_events_raw_movement_key` unique index (§1) | **High** if unaddressed — silently doubles a real financial movement's history |
| Pay | Yes | Design §7.1, standard DEBIT/CREDIT shape, no new dependency | None found | None | Low |
| Receive | Yes | Not a distinct concept; inherits Pay's schema | None found | None | Low |
| Swap | Yes | §6 — intent correlation + distinct `log_index` per leg already supported | None found | None | Low |
| UB | **Unverified** | §3 — only the failure-recovery leg traced; deposit/spend legs have zero real evidence | Unknown whether `UB_DEPOSIT`/`UB_SPEND` semantics as designed match real on-chain shape | Trace a real successful UB transfer before implementing this feature's interpreter path | **High** for this feature specifically — implementing against unverified semantics risks building the wrong thing |
| CCTP Transfer | Yes | §5 — `claims.destination_tx_hash` already proven as the join key in production code | None found | None | Low |
| CCTP Claim | Yes | Same as above; `claims.transaction_intent_id` link already designed | None found | None | Low |
| BulkPay | Yes, with one caveat | §2 — log-revert semantics are structural (EVM-level), no explicit check needed | Native-path receipt-status gap exists but doesn't affect BulkPay specifically | None for BulkPay; the native-path gap is a separate, indexer-scoped item | Low for BulkPay; Medium for the unrelated native-path finding |
| ChatPay | Yes | Identical shape to Pay | None found | None | Low |
| P2P Lock | Yes, refined | §4 — real schema + code evidence found a cleaner classifier than originally designed | None in schema; classifier logic not yet built (expected — design-only phase) | None to schema; implement `classifyP2PTransfer` per §4's revised contract | Low |
| P2P Release | Yes, refined | Same as Lock — `p2p_trades.tx_hash` confirmed as the release-specific hash | Same | Same | Low |
| P2P Refund | Yes, refined | Same — `p2p_offers.escrow_withdraw_tx_hash` confirmed as the refund-specific hash | Same | Same | Low |
| Failure states | Yes | §7 — full enum cross-check against actual `CHECK` constraints | None found | None | Low |
| Reorg | Partial | §7 — `chain_events` confirmed-event reorg gap re-confirmed (Phase 3, not new) | `confirmed -> reorged` has no signal path | Indexer-layer fix, explicitly out of scope this pass | Low today (Arc only, `confirmationDepth=0`); real once a second chain is enabled |
| Balance | Yes | §8 — no schema makes anything balance-authoritative | None found | None | Low |
| Notifications | Yes, with a caveat | §9 — table identity is sufficient; correctness depends on interpreter-layer key construction | Not a schema gap; an implementation-correctness requirement for the next phase | None to schema | Low (schema); Medium (implementation discipline required) |

---

## FINAL DECISION

# READY WITH SCHEMA CHANGES

Not "READY" outright — §1's raw-movement-identity gap is real, confirmed by direct inspection
(not assumption), and matters (a classification bug could otherwise silently double-count a real
financial movement, which is precisely the failure class this entire multi-phase effort exists
to prevent). Not "NOT READY" — every other area audited either has no gap, or has a gap that is
narrow, additive, and does not require redesigning the approved architecture from
`docs/LEDGER_CANONICAL_EVENT_DESIGN.md`/`docs/LEDGER_FEATURE_MAPPING.md`. The one genuinely
open, non-schema question (UB's real on-chain shape) blocks *implementing UB specifically*, not
the ledger architecture as a whole — Pay/Swap/CCTP/BulkPay/ChatPay/P2P can proceed on schema
that's confirmed sufficient once §1's index is added.

---

## A. Exact migrations required if schema changes proceed

**Migration 1** (new, additive to the still-unapplied Phase 1 migration — can be folded into it
directly if Phase 1 hasn't been applied yet by the time this is implemented, or as its own
follow-up migration if it has):

```sql
-- Prevents the same raw blockchain movement (same wallet's same leg of the
-- same log) from being interpreted as two different ledger_events under two
-- different event_type values. See docs/LEDGER_SCHEMA_GAP_AUDIT.md §1.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_events_raw_movement_key
  ON public.ledger_events (chain_id, tx_hash, COALESCE(log_index, -1), wallet_address)
  WHERE tx_hash IS NOT NULL;
```

No other schema changes are required by this audit's findings — every other area (§5, §6, §7,
§8, §9, §10) confirmed the existing Phase 1/2 design already supports the approved architecture.

## B. Exact constraints/indexes required

Just the one above. Everything else already exists in the (unapplied) Phase 1/2 migration files:
`transaction_intents_wallet_idem_key`, `idx_transaction_attempts_chain_txhash`,
`ledger_events_event_key_key`, `idx_notification_events_wallet_key`,
`transaction_intents_token_identity_check`/`ledger_events_token_identity_check` (Phase 2).

## C. Exact unresolved questions

1. Does `p2p_offers.escrow_deposit_tx_hash`/`escrow_withdraw_tx_hash` and `p2p_trades.tx_hash`
   ever get overwritten or left stale across a trade's lifecycle in a way that could make §4's
   classifier match the wrong action? Not independently verified beyond the write-site read
   already performed — worth a dedicated check before implementing the P2P interpreter path.
2. What does a genuinely successful (non-recovery) UB deposit+spend pair look like on-chain? See
   §3 — completely open.
3. Does the CCTP `MessageReceived` implementation-event exclusion (§8 of the design doc) need
   its own explicit rule in the interpreter, or is the `address(0)`-sender check on the *mint*
   Transfer itself sufficient (since `MessageReceived` isn't a `Transfer` log at all and
   wouldn't reach the generic classification path regardless)? Likely the latter, but not
   independently stress-tested against a real `MessageReceived` log's shape in this pass.
4. Interaction between a `REPLACED` attempt and an already-`POSTED` ledger event from a
   *different* attempt on the same intent — flagged as open in
   `LEDGER_CANONICAL_EVENT_DESIGN.md` §13, restated here since this audit did not resolve it
   either.

## D. Exact features whose real on-chain behavior is still unverified

**Unified Balance (Multichain Transfer — UB) only.** Every other feature (Pay, Swap, CCTP
Transfer, CCTP Claim, BulkPay, ChatPay, P2P Lock/Release/Refund) has either direct production
code evidence, direct live-data evidence, or both, backing its ledger semantics — traced and
cited throughout this document and its predecessor design docs. UB's deposit leg and successful-
spend leg have zero corroborating on-chain evidence in this environment (§3).

## E. Recommended Ledger implementation order

1. Apply §1's index (folded into Phase 1's still-unapplied migration, or as an immediate
   follow-up — either way, before any interpreter code writes a single `ledger_events` row).
2. Build the Ledger Interpreter's core (transaction_intent correlation + address(0)/CCTP
   exclusivity + sender-address fallback) against the features with the strongest evidence
   first: **Pay, then Swap** (both fully traced, both have real production examples in
   `chain_events`/`activity` already, per the Phase 3 observation report).
3. **CCTP Transfer/Claim** next — `claims.destination_tx_hash` correlation is already proven in
   production code, low implementation risk.
4. **BulkPay** — schema and identity fully solved (Phase 3), traced live
   (`0x435d804c…`), safe to implement.
5. **ChatPay** — trivial once Pay's engine exists (reuses it directly).
6. **P2P** — implement `classifyP2PTransfer` per §4's revised, evidence-based contract; still
   carries the residual TOCTOU risk named in §4, worth its own narrow test pass before trusting
   it in production, mirroring how the BulkPay and Claim-Recovery fixes were each verified in
   isolation before deploying.
7. **UB last, and only after §3's open questions are resolved** with real transaction tracing —
   implementing this feature's interpreter path against unverified semantics risks building
   ledger events that don't match what Circle's Gateway actually does on-chain, silently
   corrupting the one financial record this whole effort exists to make trustworthy.

## F. Estimated change budget per implementation phase

Consistent with this engagement's established "small, focused, evidence-backed" pattern (Phase
3's fixes were each 1-3 production files; the BulkPay and Claim-Recovery fixes were each 1-2
production files plus tests):

- §1's index: 1 migration file (or one addition to the existing unapplied Phase 1 file).
- Ledger Interpreter core + Pay/Swap: likely 2-4 new files (the interpreter itself, a
  classification helper, tests) — comparable in scope to the `blockchain-indexer`
  `scanner.ts`/`compare.ts` pair.
- CCTP, BulkPay, ChatPay paths: each likely 1-2 files (feature-specific classification logic
  layered on the already-built interpreter core), given the underlying identity/correlation work
  is already solved by the time these are reached.
- P2P: 1-2 files for `classifyP2PTransfer` plus its `p2p_offers`/`p2p_trades` read integration.
- UB: **not estimated** — cannot responsibly size implementation work against unverified
  semantics; the first step for this feature is investigation (tracing a real successful
  transfer), not implementation.

---

**No migration created, no production code modified, no `ledger_events` row populated, no
Activity/indexer/claim-recovery/BulkPay/P2P/Swap/Pay code touched.** Stopping here per your
instructions.
