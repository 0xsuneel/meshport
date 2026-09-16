# Ledger Real Data Shadow Validation

## 1. Environment

- **Project**: MeshPort Supabase (`cvvpzfvzweszuuxvaayb`), live production.
- **Timestamp**: 2026-08-24, this session (`chain_events.created_at` latest observed:
  `2026-08-24 06:32:07`).
- **chain_events count**: 95 total, 95 confirmed (100%) — up from 87 at the start of this
  session; real traffic occurred between the last validation and this one.
- **Table existence check** (performed fresh, not assumed): `activity`, `chain_events`,
  `claims`, `multichain_transactions`, `transactions` all exist. `transaction_intents` and
  `transaction_attempts` still do not exist (Phase 1 unapplied, confirmed again). A separate,
  legacy-looking `transactions` table exists (`id, type, status, amount, usd_value,
  sender_address, receiver_address, tx_hash, note, fee, created_at`) but contains zero rows —
  not used by any of the transactions examined.

---

## 2. Transactions inspected

| TX (truncated) | Feature | Chain | Token | Amount | Sender | Receiver | Result |
|---|---|---|---|---|---|---|---|
| `0x1da14d88…` | Pay (native) | arc | USDC | 5 | `0x05d00ab7…` | `0xebe5251…` | PASS |
| `0xafadc14e…` | Pay (native) | arc | USDC | 10 | `0x05d00ab7…` | `0xebe5251…` | PASS |
| `0x9f52959a…` | Pay (native), genuine internal | arc | USDC | 1 | `0x05d00ab7…` (sunil.arc) | `0xec883a9…` (bordsa.arc) | PASS |
| `0x4909f00d…` | Pay (native), genuine internal | arc | USDC | 1 | `0x05d00ab7…` (sunil.arc) | `0x0634f84…` (rib.arc) | PASS |
| `0x8faba4f3…` | Pay (ERC20/EURC), genuine internal — closes a long-standing gap | arc | EURC | 10 | `0x05d00ab7…` (sunil.arc) | `0x0634f84…` (rib.arc) | PASS |
| `0xef6d3410…` | Pay-shaped (external EURC deposit) | arc | EURC | 20 | `0xd4c0b787…` | `0x05d00ab7…` | PASS |
| `0x134ef96e…` | Pay-shaped (external EURC deposit, fresh, real log_index) | arc | EURC | 20 | `0xd4c0b787…` | `0x05d00ab7…` | PASS |
| `0x21b3dbf9…` | Pay-shaped (external native deposit, same sender as above) | arc | USDC | 20 | `0xd4c0b787…` | `0x05d00ab7…` | PASS |
| `0x48beda4d…` | Pay-shaped (external cirBTC deposit) | arc | cirBTC | 0.0001 | `0xd844ba11…` | `0x05d00ab7…` | PASS |
| `0xed2868e6…` | Swap output (EURC) | arc | EURC | 0.881746 | Kit Adapter | `0x05d00ab7…` | INCONCLUSIVE (SWAP_DEBIT) / PASS (no misclassification) |
| `0x91d9bd19…` | Swap output (EURC), fresh | arc | EURC | 8.4511 | Kit Adapter | `0x05d00ab7…` | same as above |
| `0xb179c4f0…` | BulkPay (Multicall3), real, 2 recipients per Activity | arc | USDC | 10 (this leg) | Multicall3 | `0xebe5251…` | SEE §8/§13 — real gap found |

12 real transactions examined in this pass (up from 6 in the prior validation).

---

## 3. Pay validation

For every genuine Pay-shaped transaction (native and ERC-20), the actual interpreter code
(`server/ledger/interpreter.ts`, run via the extended `scripts/ledger-shadow-validation.ts`)
produced exactly `DEBIT` (sender) + `CREDIT` (recipient), sharing `chain_id`/`tx_hash`/
`log_index`, differing only on `wallet_address`, with atomic amounts matching the source
`metadata.amount` exactly (string-shifted, no float multiplication). Result: PASS for all 9
Pay-shaped transactions in §2.

The most significant new evidence: `0x8faba4f3…` (EURC, `sunil.arc → rib.arc`) is confirmed, via
a real `send_`/`recv_` Activity pair, as a genuine internal ERC-20 Pay between two registered
MeshPort users — the gap flagged in every prior validation pass ("every real ERC-20 transfer
found so far was actually a swap output or an external deposit") is now closed with real data,
not a substitute.

## 4. Receive validation

Checked whether receiver-side Activity exists even where the sender's own client optimistic
write could plausibly have been the only source. For `0x9f52959a…` and `0x4909f00d…`, both
`send_`/`recv_` rows exist with matching `fromUsername`/`toUsername` pairs (`sunil.arc` ↔
`bordsa.arc`, `sunil.arc` ↔ `rib.arc`). For the external-deposit cases (`0xef6d3410…`,
`0x134ef96e…`, `0x21b3dbf9…`, `0x48beda4d…`), the `recv_` row's `metadata.note: "External
deposit (e.g. faucet)"` and `recovered: true` do positively confirm indexer/recovery-path
attribution (this exact note string is unique to `claim-recovery-scan`, confirmed in
`docs/CLAIM_RECOVERY_AUDIT.md`) — i.e., these receiver-side rows are demonstrably not dependent
on any sender-side optimistic write, since the "sender" isn't a MeshPort user with a client at
all. Consistent with blockchain → indexer → chain_events → activity-consumer/claim-recovery-scan,
not assumed.

## 5. Native validation

All native (`deposit_detected`) transactions in §2 correctly show `log_index: null`,
`is_native: true`, `token_address: null` in the predicted Ledger output — the invariant from
`docs/LEDGER_IS_NATIVE_FIX.md` holds on every real native transaction examined, including two
brand-new ones (`0x9f52959a…`, `0x4909f00d…`) not seen in the prior validation. Sender/recipient
pairs verified correct against `metadata.sender`/`metadata.recipient` directly.

## 6. ERC20 validation

All ERC-20 (`transfer_detected`) transactions correctly show `is_native: false`, `token_address`
populated with the real contract address. Critically, the previously-fixed `is_native` bug is
confirmed clean on fresh, real, post-fix data: `0x134ef96e…` and `0x48beda4d…` both have
`token_address` populated directly from `chain_events` (not needing the historical-fallback
symbol lookup at all, unlike the older `0xef6d3410…` row) — both correctly classify
`is_native: false`. No historical-EURC-style misclassification recurred.

## 7. Swap validation

Searched for a real correlation to `transaction_attempts`/`transaction_intents` for both real
swap transactions (`0xed2868e6…`, `0x91d9bd19…`) — none exists (the tables don't exist in
production at all). Per your explicit instruction, this is reported as:

`SWAP_NOT_COMPARABLE` for both swap transactions' `SWAP_DEBIT` leg — no `transaction_attempt`
or `transaction_intent` correlation exists, and (as established architecturally in the prior
validation and re-confirmed by direct query this session — `SELECT count(*) FROM chain_events
WHERE wallet_address = '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b'` → still 0) no `chain_events`
row for the input leg can exist either. Not invented.

Both swap output legs correctly returned `not_applicable` (verified: zero `SWAP_CREDIT` and zero
generic `CREDIT` rows for either transaction) — the interpreter deferred both times rather than
guess, exactly as designed.

## 8. BulkPay / Multi-log validation

`SELECT tx_hash, COUNT(*) FROM chain_events GROUP BY tx_hash HAVING COUNT(*) > 1` → zero rows,
re-confirmed fresh this session. Per your instruction not to rely on this query alone, individual
event identities were inspected directly — and this surfaced a real, important finding (§13): a
genuine BulkPay transaction occurred (`0xb179c4f0…`), correctly identified by its sender address
(`0xca11bde0…`, Multicall3 — already in `KNOWN_INTERNAL_CONTRACTS`), but `chain_events` contains
only ONE row for this transaction, while the real `activity` data proves TWO recipients were
actually paid (10 USDC to `0xebe5251…`, 14 USDC to `0x9171d4f0…`, totaling the 24 USDC the
payer's own `bulk` Activity row records). This is `MULTI_LOG_NOT_AVAILABLE` at the `chain_events`
level, but the underlying real transaction genuinely was multi-recipient — see §13 for the full
analysis; this is a materially different, more serious finding than "no multi-log transaction
has occurred yet."

## 9. Duplicate/idempotency validation

Every one of the real transactions with a predicted Ledger event (9 Pay-shaped, minus the swap
outputs and the BulkPay row which produced zero) was re-processed through
`interpretConfirmedChainEvent` a second time, using the real code. All previously-inserted
drafts returned `already_posted` — zero new rows, row count unchanged (18 → 18, confirmed by the
script's own count assertion, encompassing both this session's transactions and the 3 retained
from the prior validation pass).

Conflict simulation (real conditional-write logic, no actual write): `SWAP_CREDIT` inserted
first, then `CREDIT` attempted for the identical raw movement (`chain_id`+`tx_hash`+`log_index`+
`wallet_address`) → `{"outcome":"conflict","existingEventType":"SWAP_CREDIT"}`. Confirmed: the
raw-movement identity correctly prevents two different `event_type` classifications for the same
underlying movement, exactly as validated in the prior two passes.

---

## 10. Activity comparison

| Transaction | Predicted Ledger | Activity | Classification |
|---|---|---|---|
| `0x1da14d88…`, `0xafadc14e…` | DEBIT+CREDIT | send_/recv_ pair | MATCH |
| `0x9f52959a…`, `0x4909f00d…` | DEBIT+CREDIT | send_/recv_ pair | MATCH |
| `0x8faba4f3…` (genuine ERC20 Pay) | DEBIT+CREDIT, `is_native: false` | send_/recv_ pair, both EURC | MATCH |
| `0xef6d3410…`, `0x134ef96e…`, `0x21b3dbf9…`, `0x48beda4d…` (external) | DEBIT+CREDIT | `recv_` only, no `send_` | EXPECTED_DIFFERENCE — external sender has no MeshPort Activity of its own; not a gap |
| `0xed2868e6…`, `0x91d9bd19…` (swap output) | nothing (`not_applicable`) | `swap`-type row (correct) | NOT_COMPARABLE — Ledger produced no competing row to compare against; the historical `receive` duplicate on the first of these two remains present in Activity (pre-existing, not new) |
| `0xb179c4f0…` (BulkPay) | one DEBIT+CREDIT pair (for the ONE recipient chain_events actually captured) | one payer row + TWO recipient rows | LEDGER_CLASSIFICATION_GAP — root cause is upstream (chain_events incompleteness, §13), not a Ledger interpreter defect |

No case in this pass fell into plain ACTIVITY_MISMATCH (Activity itself was internally
consistent with what it claims in every case examined).

## 11. Ledger classification gaps

One, newly and precisely characterized: for `0xb179c4f0…`, the Ledger Interpreter can only ever
predict events for what `chain_events` actually contains. Since `chain_events` itself is missing
the second recipient's leg, the Ledger's predicted output is incomplete relative to the real,
true economic transaction — not because the interpreter misclassified anything (it correctly
processed the one row it was given), but because its input was incomplete. This is best
understood as `LEDGER_CLASSIFICATION_GAP` caused by a `MISSING_CHAIN_EVENT` condition one layer
below.

## 12. NOT_COMPARABLE cases

- Both real swaps' `SWAP_DEBIT` legs — `SWAP_NOT_COMPARABLE`, no `transaction_intent`/
  `transaction_attempt` data exists, and the input leg is architecturally invisible to
  `chain_events` (§7).
- The swap output legs themselves, once correctly deferred (`not_applicable`) — nothing to
  compare against Activity's `swap` row, since the Ledger intentionally produced zero rows.

## 13. Bugs discovered

No Ledger Interpreter classification or duplication bug was found in this pass (the `is_native`
bug from the prior pass remains fixed and confirmed clean on fresh data, §6).

One real, significant, newly-discovered issue — outside the Ledger Interpreter itself:

`chain_events` is missing at least one leg of a real, confirmed BulkPay transaction
(`0xb179c4f0691199d5a1fdfc49d5086cf587f5440b13c768629a2913f7f783714c`). Real `activity` data
proves the transaction paid two recipients (10 USDC to `0xebe52519…`, 14 USDC to `0x9171d4f0…`,
`metadata.recipients` array on the payer's own `bulk` row lists both explicitly, totaling the
recorded 24 USDC). `chain_events` contains exactly one row for this `tx_hash` (the 10 USDC leg
to `0xebe52519…`) — the 14 USDC leg to `0x9171d4f0…` has no corresponding `chain_events` row at
all, confirmed by direct query (zero rows for this `tx_hash` beyond the one already found, and
zero rows anywhere for `wallet_address = '0x9171d4f0d376019297d9598c33cdc6e92413f730'` in this
specific transaction's context).

Exact file / problem (per your "if you discover a bug" instruction — documented, not fixed, no
indexer code touched in this pass): the mechanism is in
`supabase/functions/blockchain-indexer/scanner.ts`'s native-transfer-log scan path (the
`0xffffffffffffffffffffffffffffffffffffffffe` contract, `via: "native-transfer-log"` in
`metadata` — confirmed present on the one row that was captured). Root cause not independently
diagnosed in this read-only pass — plausible candidates include a chunk boundary in
`eth_getLogs` splitting the two recipients' logs across scan windows unevenly, a log ordering/
parsing issue specific to two internal calls in one Multicall3 batch, or something else entirely.
Recommended next step: a dedicated, narrowly-scoped forensic investigation of this exact
transaction's raw `eth_getLogs` response (via direct RPC call, read-only, no code change) before
any BulkPay Ledger work begins — this is exactly the kind of gap the original Phase 3 shadow
comparison work was built to catch, and it's now been caught, on real data, for the first time.

Financial impact: Activity (via the client's own optimistic `bulk`/`bulkReceived` writes,
protected by the BulkPay safety fix's TOCTOU guard) still correctly credited both recipients —
no money was lost or misrepresented to any user. The gap is specifically in `chain_events`'
completeness as a would-be independent, indexer-driven source of truth — exactly the property a
future authoritative Ledger would depend on.

## 14. Recommended next step

1. Before any further Ledger work on BulkPay specifically: investigate the exact root cause of
   the missing `chain_events` row for `0xb179c4f0…`'s second recipient — read-only RPC
   inspection of the real transaction's logs, no code change, a natural follow-up to this
   validation rather than a new phase.
2. Continue treating Pay (native and ERC-20) and the swap-output-deferral guarantee as validated
   against real data — both hold cleanly across every transaction examined in this and the prior
   pass.
3. Swap's `SWAP_DEBIT` remains blocked on Phase 1 application (`transaction_intents`/
   `transaction_attempts`) — unchanged conclusion from every prior pass.

---

## FINAL VERDICT

# B — PASS WITH KNOWN GAPS

Not A: a real, newly-discovered data-completeness issue exists (§13) — calling this clean would
misrepresent it.

Not C: per your own stated criterion, C applies only when real data exposes an actual
financial-classification or duplication bug in the Ledger interpretation itself. The `is_native`
bug from the prior pass (which would have justified C) is confirmed fixed on fresh real data
(§6). The BulkPay gap found in this pass is a `chain_events`/indexer completeness issue, not a
Ledger classification or duplication defect — the interpreter correctly, faithfully processed the
one row it was given, and produced no duplicate, no misclassification, and no financial event
where uncertainty existed. It is reported prominently (§13/§11) as exactly the kind of real,
consequential gap "B" is meant to capture, not minimized.

Everything from the prior validation that remains true, restated for completeness: Pay (native
and ERC-20) — validated clean, now with genuine internal-Pay evidence closing the previous ERC-20
gap. Swap output — correctly deferred, never misclassified, across two real transactions now.
Swap input/`SWAP_DEBIT` — still blocked on Phase 1. UB — still not examined in this pass (no new
evidence sought or found). `p2p-release-reconcile` cron — unchanged, not touched.

---

No production writes occurred at any point. No `ledger_events` created, no migration applied, no
Activity/indexer/Pay/Swap/BulkPay code modified, no deployment. `scripts/ledger-shadow-
validation.ts` was extended with 6 new real transaction fixtures (unchanged in its actual logic)
and this report is the only other artifact produced. Stopping here per your instructions — not
proceeding to CCTP/BulkPay/P2P/UB.
