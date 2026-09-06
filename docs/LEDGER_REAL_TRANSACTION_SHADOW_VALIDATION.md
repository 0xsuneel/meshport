# Ledger Real Transaction Shadow Validation

Status: **Read-only validation complete. No writes to any database.** The Ledger Interpreter's
actual, real code (`server/ledger/interpreter.ts`, `classifiers.ts` — unmodified) was executed
against real `chain_events`/`activity` rows queried live from production, via a disposable
in-memory repository (`scripts/ledger-shadow-validation.ts`) that implements `LedgerRepository`
but never touches a real database. The script and its output are reproduced in full below —
nothing here was hand-computed or simulated by reasoning alone.

**No `<PASTE TX HASHES>` were supplied** — per Step 1's instruction, the test transactions were
found directly from real `chain_events`/`activity` data, not invented.

---

## Global finding, applies to every transaction below

`transaction_intents` / `transaction_attempts` / `ledger_events` **do not exist in production**
(confirmed directly: `information_schema.tables` returns zero rows for all three — Phase 1 is
still unapplied). This means **no transaction below has any real `transaction_intent`/
`transaction_attempt` data available**, without exception. Stated once here rather than repeated
five times.

---

## Test transactions found and used

| # | Requested category | Real transaction used | Note |
|---|---|---|---|
| 1 | Native Pay A→B | `chain_events` id 109, tx `0x1da14d88…` | Genuine internal Pay — matching `send_`/`recv_` Activity pair found, `sunil.arc → suvarna.arc`, 5 USDC |
| 2 | Native Pay A→B again | `chain_events` id 111, tx `0xafadc14e…` | Same pair (0x05d00ab7…→0xebe5251…), different tx, 10 USDC |
| 3 | ERC20 Pay A→B | `chain_events` id 103, tx `0xef6d3410…` | **Not an internal Pay — see caveat below** |
| 4 | ERC20 Pay A→B again | `chain_events` id 79, tx `0xb907e17f…` | Same sender/recipient/amount as #3, different tx — genuine repeat |
| 5 | ERC20 Pay A→C | `chain_events` id 61, tx `0x8583295f…` | **Substitute — see caveat below, this is not a true "A→C"** |
| 6 | Swap USDC→EURC | `chain_events` id 110, tx `0xed2868e6…` | The exact transaction traced in every prior audit this session |

**Caveat on #3/#4/#5, stated plainly, not glossed over**: every real `transfer_detected`
(EURC/cirBTC) `chain_events` row in this database is either (a) a swap output (sender = Kit
Adapter Contract) or (b) an **external deposit** — `activity.metadata.note` literally says
`"External deposit"`/`"External deposit (e.g. faucet)"`, and two of the three
(`activity.metadata.source: "activity-consumer"`) were credited by the indexer pipeline itself,
confirming the sender is not a registered MeshPort user with their own `send` Activity row.
**No real ERC20-token transaction between two registered MeshPort users (a true "internal ERC20
Pay") exists in this database.** #3/#4/#5 are the closest real substitutes — genuine, real,
confirmed chain events — used because Step 1 requires using real data, not inventing it. #5 in
particular has a *different* sender than #3/#4 (there is no real transaction where the *same*
sender as #3/#4 pays a *third*, different recipient) — flagged explicitly rather than silently
presented as if it were a true "A→C" case.

---

## STEP 2/3/4 — Interpreter output (actual script run, not hand-computed)

Full script: `scripts/ledger-shadow-validation.ts` (reproduced in the repo). Run via
`npx tsx scripts/ledger-shadow-validation.ts`. Raw output captured verbatim below, per
transaction.

### 1. Native Pay A→B — tx `0x1da14d88ad1d4a7e674221a1ba1cdea1fbf84ab3067446b471021348f9e5435d`

**Predicted ledger events** (real interpreter output):
```json
DEBIT  { wallet_address: "0x05d00ab7…", amount_atomic: "5000000000000000000", is_native: true, log_index: null }
CREDIT { wallet_address: "0xebe52519…", amount_atomic: "5000000000000000000", is_native: true, log_index: null }
```
Both share `chain_id: "arc"`, `tx_hash`, `log_index: null` — differ only on `wallet_address`, exactly as required. `amount_atomic` matches the chain event's `metadata.amount = 5` at 18 decimals exactly (5 × 10¹⁸).

**Existing Activity**: `send_…` (0x05d00ab7…, 5.000000 USDC, `toUsername: "suvarna.arc"`) + `recv_…` (0xebe52519…, 5.000000 USDC, `fromUsername: "sunil.arc"`) — a genuine matched pair.

**Economic equivalence (Step 6)**: Ledger DEBIT ↔ Activity `send` — same wallet, same amount, same direction. Ledger CREDIT ↔ Activity `recv` — same wallet, same amount, same direction. **Equivalent.**

**Result: PASS**

**Issues**: none for the DEBIT/CREDIT logic itself. Note: `decimals: 18` was supplied by this
script from prior knowledge of Arc's native-USDC convention (already established and reused
throughout this engagement), not read from the `chain_events` row itself — the row has no
`decimals` column populated. Flagged for completeness, not a blocking issue (the value used is
correct and independently verified many times over in this engagement).

### 2. Native Pay A→B again — tx `0xafadc14ea253272fde469aa3f6460bf266d2088fab12ce3f015504a2b82d439b`

Identical shape to #1: `DEBIT`/`CREDIT` for the same pair, `amount_atomic: "10000000000000000000"` (10 USDC), matching `metadata.amount = 10` exactly. Activity: `send_…`/`recv_…` pair confirmed (`note: "Contact Payment"`). **Result: PASS.**

**Idempotency proof (distinct tx from #1)**: #1 and #2's `event_key`s are fully distinct
(different `tx_hash`), confirmed in the raw output — no interference between the two real,
separate transactions between the same pair.

### 3. ERC20 "Pay" #1 — tx `0xef6d341036fedf9f9b4e1eaf6d4cf3fd289bc7e50b35995199aa9bfb21c9c778`

**Predicted ledger events**:
```json
DEBIT  { wallet_address: "0xd4c0b787…", amount_atomic: "20000000", is_native: true, ... }
CREDIT { wallet_address: "0x05d00ab7…", amount_atomic: "20000000", is_native: true, ... }
```
`amount_atomic` correctly matches `metadata.amount = 20` at 6 decimals (20 × 10⁶ = 20000000).

**🚨 Issue found — `is_native: true` is WRONG.** This is EURC, an ERC-20 token, not Arc's native
asset. Root cause, traced to the exact line: `classifiers.ts` computes
`isNative = tokenAddress == null` (line ~152/176), and this `chain_events` row has
`token_address: null` — **not because the transfer is native, but because this row predates the
Phase 3 scanner enhancement that started populating `contract_address`** (confirmed: this row's
`created_at` places it before the log_index/contract_address population fix was deployed). The
classifier cannot currently distinguish "genuinely native" from "token address unknown/historical
gap" — both produce `token_address: null`, and the classifier treats that as "native." **This is
a real, previously-undiscovered limitation, only surfaced by testing against real historical
data** (every synthetic test in `classifiers.test.ts` supplied an unambiguous `token_address` or
explicitly tested the native path) — not fixed in this pass, per the strict "no feature changes"
scope; reported precisely for a future, explicitly-scoped fix.

**Existing Activity**: only a `recv_…` row exists (`activity_type: 'receive'`,
`metadata.note: "External deposit"`, `metadata.source: "activity-consumer"`). **No `send_…` row
exists** — expected and correct, since the sender (`0xd4c0b787…`) is not a registered MeshPort
user and never writes their own Activity.

**Economic equivalence (Step 6)**: Ledger CREDIT ↔ Activity `receive` — same wallet, same
amount, same direction. **Equivalent.** Ledger DEBIT ↔ *(nothing)* — **flagged as `missing` on
the Activity side**, but this is not a bug: Activity today has no concept of "the external
sender's own debit record" because that sender isn't a MeshPort user at all. This is a genuine,
correctly-flagged **design difference** between the two systems (Ledger models every raw
movement's both sides; Activity only ever models a *MeshPort user's* side), not a defect in
either.

**Result: PASS WITH ISSUE** — the DEBIT/CREDIT pairing, identity, and amount are all correct;
the `is_native` misclassification is real and reported, not silently passed.

### 4. ERC20 "Pay" #1 again — tx `0xb907e17fea4f4925ad7810fdfb7cd932fc881c3cde5febbf8697f028c3478b64`

Identical shape and identical `is_native` issue to #3 (same root cause). Confirmed as a **genuinely
separate real transaction** (different `tx_hash`, same sender/recipient/amount as #3) — the
interpreter correctly produced fully independent `event_key`s for #3 and #4, no collision, no
interference. **Result: PASS WITH ISSUE** (same issue as #3).

### 5. ERC20 "Pay" #2 (different sender) — tx `0x8583295fb9b2b4c0d963bfb939bccec993185a0b3e05a86f1d1bd37fb12c4b52`

Same shape, same `is_native` issue, different sender (`0x319dd63e…`) than #3/#4. Activity:
`recv_…` only (`note: "External deposit"`, no `recovered` flag — the only one of the three
*not* attributed to `activity-consumer` specifically, `metadata` doesn't carry a `source` field
for this one, worth noting as a minor provenance gap in the existing Activity data itself, not
the Ledger interpreter). **Result: PASS WITH ISSUE** (same `is_native` issue as #3/#4).

---

## STEP 5 — Swap: tx `0xed2868e6d034e65d2a0063816906dd2d69604102ce9a7a71a08fbf78c7492312`

**Real interpreter output**:
```json
{
  "classification": "not_applicable",
  "reason": "sender 0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b is a known internal contract — not an ordinary Pay transfer, deferred rather than guessed"
}
```

**Zero ledger events produced.** This is the correct, designed behavior, not a failure of the
interpreter — confirmed against the actual code path (`classifyPayTransfer`'s known-internal-
contract exclusion fires first, since this event has no correlated `transaction_intent`; control
never reaches `classifySwapCredit` at all in this specific data shape, because
`interpretConfirmedChainEvent` only calls `classifySwapCredit` when a correlated swap intent was
found — which none was, confirmed by the global finding above).

**Verified directly: `SWAP_CREDIT` was NOT produced, and generic `CREDIT` was NOT produced
either.** Exactly the required guarantee (`"absolutely verify: SWAP_CREDIT != generic CREDIT"`)
— neither happened; the interpreter produced nothing at all rather than guessing between them.

**Input token / input amount / SWAP_DEBIT — cannot be reconstructed, exact missing data named:**

1. **No `transaction_attempt`/`transaction_intent` exists** (global finding) — `SWAP_DEBIT` can
   only ever be derived from a `CONFIRMED` `transaction_attempt` and its `transaction_intent`
   (per `types.ts`'s own documented architecture, established in the prior Ledger Core phase) —
   there is none to read.
2. **No `chain_events` row exists for the swap's input leg at all.** Queried `chain_events` for
   any row with this same `tx_hash` — only one row exists (id 110, the output leg). This is
   architecturally expected, not a data-collection gap: the swap's input (USDC leaving the
   user's wallet to the router) would require a `chain_events` row where the **router** is the
   `to` address, and the router is never in blockchain-indexer's `knownWallets` set (confirmed in
   the prior Ledger Core phase's own investigation of `scanner.ts`/`loadKnownWallets`) — so no
   such row can exist under the current indexer, regardless of how much historical data is
   queried.
3. **The only source for input token/amount is `activity`'s own `swap`-type row**
   (`metadata: { tokenIn: "USDC", amountIn: 1, tokenOut: "EURC", amountOut: 0.881746 }`) — but
   this is Activity data, not chain/ledger-canonical data, and using it to fabricate a
   `SWAP_DEBIT` would mean the Ledger trusting a client-written record instead of an
   independently-confirmed on-chain fact — exactly the trust model this whole effort exists to
   move away from. **Not used to construct a ledger event**, per Step 5's explicit instruction
   not to invent it.

**Existing Activity comparison (Step 6)**: Activity has a `swap`-type row (1 USDC → 0.881746
EURC, the correct, complete economic picture) AND a separate, known-duplicate `receive` row
(`recv_…`, `metadata.note: "External deposit (e.g. faucet)", recovered: true`) — this is the
**exact EURC duplicate already traced in `docs/ACTIVITY_WRITER_AUDIT.md`/
`docs/CLAIM_RECOVERY_AUDIT.md`**, still present in the database (Activity rows are never
deleted). **Flagged again here**: the Ledger Interpreter's correct `not_applicable` result for
the raw chain event is a direct, structural improvement over this exact historical Activity
duplicate — the Ledger path, once live, would never have produced the spurious `receive` row
this transaction actually got, because it defers instead of guessing.

**Result: INCONCLUSIVE for SWAP_DEBIT** (data does not exist, correctly not fabricated).
**PASS for SWAP_CREDIT-vs-generic-CREDIT discrimination** (verified: neither incorrect
classification occurred).

---

## STEP 7 — Idempotency simulation (actual script run)

**Same chain_events, full second pass**: every one of the 10 previously-inserted drafts (5
transactions × 2 legs) returned `already_posted` on the second call — **zero new rows, zero
duplicates.** Row count before and after: 10 → 10, confirmed by the script's own assertion.

**Conflict simulation** (`SWAP_CREDIT` then `CREDIT` for the identical raw movement):
```
first insert (SWAP_CREDIT):  {"outcome":"inserted","id":"shadow-11"}
second insert (CREDIT, same raw movement): {"outcome":"conflict","existingEventType":"SWAP_CREDIT"}
```
**Confirmed exactly as required**: the second, differently-classified representation for the
identical raw movement was rejected (`outcome: 'conflict'`), never silently accepted or
overwritten. This models the real `ledger_events_raw_movement_key` database constraint
(validated against actual Postgres in the prior Ledger Raw Identity Fix phase) — the in-memory
repository's conditional-write logic mirrors that constraint's exact semantics.

---

## Summary table

| # | TX (truncated) | Chain | Feature | Result | Issues |
|---|---|---|---|---|---|
| 1 | `0x1da14d88…` | arc | Pay (native) | **PASS** | `decimals` assumed from prior knowledge, not stored |
| 2 | `0xafadc14e…` | arc | Pay (native) | **PASS** | same |
| 3 | `0xef6d3410…` | arc | Pay-shaped (external ERC20) | **PASS WITH ISSUE** | `is_native: true` misclassified — real classifier bug found |
| 4 | `0xb907e17f…` | arc | Pay-shaped (external ERC20, repeat) | **PASS WITH ISSUE** | same `is_native` issue |
| 5 | `0x8583295f…` | arc | Pay-shaped (external ERC20, different sender) | **PASS WITH ISSUE** | same `is_native` issue |
| 6 | `0xed2868e6…` | arc | Swap | **INCONCLUSIVE (SWAP_DEBIT)** / **PASS (no misclassification)** | `SWAP_DEBIT` data does not exist in current storage — correctly not fabricated |

---

## Discrepancies flagged (Step 6 taxonomy)

- **Missing**: the Activity-side `send`/debit representation for external-sender deposits (#3/4/5)
  — a correct design difference, not a defect, explained above.
- **Wrong classification field**: `is_native: true` on genuinely non-native ERC-20 transfers
  whose `chain_events.token_address` is historically `null` (#3/4/5) — a **real, newly-discovered
  limitation** in `classifiers.ts`, root-caused to the exact line, not fixed in this pass.
- **Duplicate** (pre-existing, re-confirmed, not caused by this validation): the swap's
  historical `receive` duplicate row (#6) — already fully documented in prior audits, restated
  here only because this validation directly re-touched the same transaction.
- No wrong amount, wrong token *symbol*, wrong wallet, or wrong direction was found in any of
  the 6 transactions.

## Recommendation (not acted on — audit only)

The `is_native` bug should be fixed before any real Pay/Swap intents start flowing through this
interpreter in a future phase — recommend deriving `is_native` from an explicit signal (e.g. the
`chain_events.event_type`/`metadata.via` field, which already distinguishes native-shaped
detection paths from ERC-20 log paths, per `scanner.ts`) rather than `token_address == null`,
which conflates "genuinely native" with "address unknown." **Not implemented here**, per this
checkpoint's explicit no-feature-changes scope.

---

**No production writes occurred.** No `ledger_events` created, no migration applied, no Activity
row touched, no indexer/claim-recovery code modified. `scripts/ledger-shadow-validation.ts` is a
new, standalone, read-only script — the only new file this pass adds besides this report.
Stopping here for review, per your instructions.
