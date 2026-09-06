# Ledger Controlled Transaction Test Plan

Status: **planning only**. No code changed, no transaction executed, no migration applied, no
`ledger_events` created. This document tells you exactly which real transactions to perform
manually and what to send back afterward — nothing else happens until you provide transaction
hashes.

---

## 1. Current supported transaction capabilities (inspected fresh, not assumed)

| Capability | Confirmed from | Detail |
|---|---|---|
| Chain | `supabase/functions/blockchain-indexer/chains.ts` | Arc only is enabled/scanned. 4 other chains are declared but `enabled: false`. |
| Native asset | same | USDC is Arc's native currency (18-decimal wei-style). |
| ERC-20 tokens watched | same | EURC (`0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`, 6 decimals), cirBTC (`0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF`, 8 decimals). |
| Send/Pay token choice | `src/features/send/SendPage.tsx` (fresh read) | Supports sending USDC, EURC, or cirBTC directly — `sendUSDC`/`sendEURC`/`sendCirBTC`, token picker in the UI. A genuine ERC-20 Pay between two real MeshPort users is possible today via the normal Send flow — not previously exercised in the historical data audited so far (every real ERC-20 transfer found in that data turned out to be a swap output or an external deposit), but the capability exists. |
| Swap pairs | `src/features/swap/SwapPage.tsx` (fresh read) | `SWAP_TOKENS = [USDC, EURC, cirBTC]` — any pair where `tokenIn !== tokenOut` is selectable (USDC↔EURC, USDC↔cirBTC, EURC↔cirBTC, both directions). |
| BulkPay | `src/features/bulkpayout/BulkPayoutPage.tsx` (fresh read) | Uses Multicall3 `aggregate3Value`, paying native USDC to each recipient via an internal `target.call{value}("")` — not an ERC-20 batch. |
| Wallet/account setup | prior sessions' real data | Real, already-active test accounts exist in this environment (e.g. usernames seen in real Activity data such as `sunil.arc`/`suvarna.arc`) — use two of your own registered test wallets; specific addresses aren't prescribed here since I don't have UI access to create or verify accounts myself. |

**Important, evidence-based finding for §6 (multi-log)**: BulkPay's individual recipient
transfers are internal calls, not top-level transactions — `chains.ts`'s own documented
reasoning for watching the `0xffffffffffffffffffffffffffffffffffffffffe` native-transfer-log
contract is precisely this case ("credits that carry no top-level `tx.value` because the
transfer was made through a contract call"). This means a real BulkPay transaction should
produce multiple `chain_events` rows — one per recipient, each with its own `log_index` — via
that log path, even though the top-level native block scan alone would miss them. This has
never been empirically observed (zero real multi-log transactions exist in `chain_events` to
date, confirmed by direct query), but the mechanism is real and already fixed for correct
identity handling (Phase 3). This is the single highest-value test available to close the
multi-log gap.

---

## 2. Test matrix

| # | Category | Status | Notes |
|---|---|---|---|
| A | ERC20 Pay | REALISTIC NOW | Send EURC directly, wallet-to-wallet, via SendPage |
| B | ERC20 Pay to another wallet | REALISTIC NOW | Same mechanism, different recipient |
| C | ERC20 Pay to a third wallet | REALISTIC NOW, but optional | Only adds marginal coverage over A/B — see §12 |
| D | Native token Pay | REALISTIC NOW | Already proven working in prior real-data validation (`0x1da14d88…`) — no new transaction strictly required, but one more strengthens the idempotency/duplicate test |
| E | External ERC20 Receive | REALISTIC NOW, but already covered | Every real ERC-20 transfer found in prior audits was this case — no new transaction needed |
| F | Swap USDC → EURC | REALISTIC NOW | Already proven once (`0xed2868e6…`) — a fresh one is still useful to test with the fixed `is_native` classifier |
| G | Swap EURC → USDC | REALISTIC NOW | Reverse direction, genuinely new coverage (native output leg, not ERC-20 output) |
| H | Multiple transfers in one tx | REALISTIC NOW, UNTESTED MECHANISM | Via BulkPay with 2-3 recipients — see §1's finding |
| I | Failed/reverted transaction | NOT RECOMMENDED TO MANUFACTURE | See §7 |
| J | UNKNOWN/pending transaction | NOT AVAILABLE | See §8 |
| K | Receiver app closed/offline | REALISTIC NOW | No special setup — just don't open the receiver's session |
| L | Duplicate/retry processing | REALISTIC NOW, NO NEW TRANSACTION NEEDED | Re-run the read-only interpreter twice against any transaction already collected |

---

## 3. Exact transactions to perform (minimum set — see §12 for the final recommendation)

### TEST 1 — ERC20 Pay (EURC, A→B)
- Action: Send Payment → select EURC → send to a second wallet you control
- Amount: smallest convenient amount (e.g. 1.00 EURC)
- Chain: Arc (only option)
- Token: EURC
- Sender: your primary test wallet
- Receiver: your second test wallet
- Expected raw blockchain event: one ERC-20 `Transfer` log on the EURC contract
- Expected chain_event: `transfer_detected`, `contract_address` = EURC contract, real
  `log_index` populated (this transaction post-dates the Phase 3 fix, unlike the historical rows
  already traced)
- Expected Ledger event (predicted, read-only): `DEBIT` (sender) + `CREDIT` (recipient),
  `is_native: false`, `token_address` = the real EURC contract address — this exercises the
  correct, non-buggy path directly, since `token_address` will be populated this time, not the
  historical-gap fallback path
- Expected Activity: `send_…`/`recv_…` pair, both `token_symbol: EURC`
- Expected notification: existing client-side notification for the recipient (unaffected —
  Ledger has no notification projection yet)
- What this proves: a genuine, non-external, non-swap ERC-20 Pay — closes the "every real
  ERC-20 transfer was actually a swap/external deposit" gap from prior validation
- Save TX hash: YES

### TEST 2 — ERC20 Pay again (EURC, A→B, repeat)
- Action: same as TEST 1, same two wallets, a different amount
- Expected: identical shape to TEST 1, different `tx_hash`, fully independent `event_key`s
- What this proves: two genuinely separate real ERC20 Pay transactions between the same pair
  don't interfere with each other
- Save TX hash: YES

### TEST 3 — Swap EURC → USDC (the reverse direction)
- Action: Swap → EURC → USDC, smallest convenient amount
- Expected raw blockchain event: two Transfer logs — EURC leaving your wallet (input, still
  architecturally invisible to `chain_events`, per the already-documented swap asymmetry) and
  native USDC arriving (output, visible via the native-transfer-log path)
- Expected chain_event: one `deposit_detected` row (native USDC output), `via:
  "native-transfer-log"`, real `log_index`
- Expected Ledger event (predicted): not_applicable for the output leg — sender is the swap
  router (Kit Adapter Contract), no correlated `transaction_intent` exists (Phase 1 unapplied),
  so the interpreter defers exactly as designed. Zero rows, same as every swap tested so far.
- Expected Activity: `swap`-type row (EURC → USDC) — and, per the still-open Claim-Recovery race
  (`docs/CLAIM_RECOVERY_AUDIT.md`), possibly a duplicate `receive` row for the native output leg,
  same known risk as the original EURC swap trace
- What this proves: the swap-deferral behavior holds for the native-output direction too, not
  just the ERC-20-output direction already tested
- Save TX hash: YES

### TEST 4 — BulkPay with 2-3 recipients (the multi-log test)
- Action: BulkPay → add 2 or 3 real recipient wallets you control → smallest convenient amount
  per recipient → send
- Expected raw blockchain event: ONE Multicall3 transaction, N internal native-value calls
- Expected chain_event: N separate rows, same `tx_hash`, different `log_index` values, one per
  recipient — this is the untested mechanism from §1
- Expected Ledger event (predicted): N independent `DEBIT` (payer)/`CREDIT` (each recipient)
  pairs, per `docs/LEDGER_CANONICAL_EVENT_DESIGN.md` §6's BulkPay reasoning — if each recipient
  is picked up as its own `chain_events` row as expected
- Expected Activity: one `bulk` row (payer) + one `bulk`/`direction:received` row per recipient
  (per `docs/BULKPAY_ACTIVITY_SAFETY_FIX.md`'s guard, already deployed)
- What this proves: whether the multi-log identity mechanism actually works on a real
  transaction — the single highest-value unresolved test in the whole plan
- Save TX hash: YES

### TEST 5 — Receiver app closed
- Action: perform ONE normal Pay (native USDC is simplest and fastest to confirm) to a wallet
  whose owning session/app you do not open at all during or after the send
- Expected: the indexer (running independently on its own cron, `*/2 * * * *`) picks up the
  transfer and it appears in `chain_events` regardless of whether the receiver's app was ever
  opened — confirmable purely by querying `chain_events` afterward, no receiver action needed
- What this proves: the indexer path doesn't depend on any client being online — addresses the
  "sender-side optimistic Activity creation" concern at the chain_events layer, without touching
  Activity code
- Save TX hash: YES

Tests beyond these (a third-wallet ERC20 Pay, a second/third native Pay) add only marginal
coverage over Tests 1/2/5 — see §12 for why they're not in the recommended minimum set.

---

## 4. Expected Ledger mapping (summary table)

| Test | Predicted event_type(s) | is_native | token_address |
|---|---|---|---|
| 1, 2 (ERC20 Pay) | `DEBIT` + `CREDIT` | `false` | real EURC address (populated fresh, not the historical-gap fallback) |
| 3 (Swap EURC→USDC) | none (`not_applicable`) | n/a | n/a |
| 4 (BulkPay, N recipients) | N × (`DEBIT` + `CREDIT`) | `true` (native USDC) | `null` |
| 5 (Native Pay, receiver offline) | `DEBIT` + `CREDIT` | `true` | `null` |

## 5. Expected Activity behavior

Unchanged from today's live behavior in every case — this plan does not touch Activity, and
none of these tests are expected to change what Activity currently does. Tests 1/2/4/5 should
produce clean, correct Activity rows with no duplicate. Test 3 (swap) carries the same
already-documented duplicate-receive risk as every prior swap trace — expected, not a new
finding, and not fixed by this plan.

## 6. Expected failure behavior

No test in this plan is designed to fail on-chain. See §7 for why a genuine reverted transaction
is not recommended to manufacture.

## 7. Multi-log strategy

Covered by Test 4. This is the only realistic path to real multi-log data — confirmed by
inspection that BulkPay is the only current UI feature that could produce it (Swap produces at
most 2 logs on 2 different transactions/legs, never 2 logs on the same tx_hash in the current
architecture; ordinary Pay is always single-log or single-native-transfer). If BulkPay isn't
performed, this gap remains open — that's an acceptable, honestly-reported outcome, not a reason
to modify BulkPay just to force a test.

## 8. Receiver-offline test

Covered by Test 5. No code change needed to test this — it's a pure operational/procedural test
of already-existing indexer behavior.

## 9. Swap validation

Covered by Test 3 (new direction) plus the already-available `0xed2868e6…` (EURC output,
already fully traced). Together these cover both possible output-token shapes (ERC-20 output,
native output) for the swap-deferral guarantee. `SWAP_DEBIT` remains untestable with real data
no matter what transaction is performed — this is architectural (§1's swap-asymmetry finding,
already proven empirically in the prior real-data validation), not something any new test
transaction can close. Restated here so it isn't mistaken for an oversight in this plan.

## 10. What data to record

For every transaction performed, record exactly:

```
TX_HASH:
CHAIN:      (Arc, unless something changes)
TOKEN:      (USDC / EURC / cirBTC)
AMOUNT:
SENDER:     (wallet address)
RECEIVER:   (wallet address, or list for BulkPay)
TIME:       (approximate, for correlating against indexer cron cadence)
```

Once you provide these, the next phase (explicitly not this task) will:
1. Query `chain_events` (and `transaction_attempts`/`transaction_intents`, expected empty) for
   each `tx_hash`, read-only.
2. Run the real `server/ledger/interpreter.ts` against the real, queried `chain_events` rows via
   the same read-only, in-memory-only script pattern already used and proven in
   `docs/LEDGER_REAL_DATA_SHADOW_VALIDATION.md` and `docs/LEDGER_IS_NATIVE_FIX.md` — no
   `ledger_events` row created.
3. Compare predicted Ledger output vs. real `chain_events` vs. real Activity, exactly as before.
4. Report a fresh `docs/LEDGER_REAL_DATA_SHADOW_VALIDATION.md`-style result specifically for
   these new transactions.

## 11. What tests are unavailable

- **I. Failed/reverted transaction**: not recommended to manufacture. The app's own preflight
  checks (balance/slippage/validation) are specifically designed to prevent a transaction from
  ever reaching the chain in a state that would revert — deliberately bypassing them (e.g. via
  direct contract interaction outside the UI) would mean testing a code path the app itself
  doesn't normally exercise, and risks producing confusing, hard-to-interpret on-chain state for
  a testnet wallet with no compensating architectural benefit. No historical reverted
  transaction exists to use instead (confirmed: 87/87 `chain_events` rows are `confirmed`, and —
  separately — a reverted transaction produces zero logs in the first place per fundamental EVM
  semantics, so it would never appear in `chain_events` even if one had occurred).
  Recommendation: skip this test entirely. The `REVERTED`/`DROPPED` code paths remain verified
  only at the unit-test level (`classifiers.test.ts`), which is already real, executed
  verification — just not against live chain data.
- **J. UNKNOWN/pending**: NOT AVAILABLE. Arc's `confirmationDepth = 0` means a block is eligible
  for `'confirmed'` status the instant the indexer observes it — there is no window in which a
  row would sit at `'pending'` for any observable duration, confirmed by 87/87 real rows never
  having been anything but `confirmed`. `transaction_attempts`' `UNKNOWN` state has no table to
  exist in at all in production. No real-world action can produce this — do not attempt to slow
  or corrupt the indexer to force it.

## 12. Final recommended minimum transaction set

5 transactions — Tests 1, 2, 3, 4, 5 above. This is deliberately the smallest set that covers
every category marked REALISTIC NOW in §2 without redundancy:

- Tests 1+2 together prove ERC20 Pay (categories A/B) and give a second, independent transaction
  for the duplicate/idempotency check (category L needs no new transaction — it's satisfied by
  re-running the interpreter twice against any already-collected transaction, per §10 step 2).
- Test 3 closes the swap-output-direction gap (category G) alongside the already-available EURC
  case (F).
- Test 4 is the one genuinely uncertain, highest-value test (category H) — closing this gap
  either confirms the multi-log identity mechanism works on real data, or surfaces a real,
  previously-unobservable issue worth knowing about before CCTP/BulkPay Ledger work ever begins.
- Test 5 closes the receiver-offline category (K) at zero marginal transaction cost (it can even
  reuse Test 1 or 2's own transaction — no dedicated new send is strictly required if you simply
  don't open the receiver's session for one of those).

Category C (a third-wallet ERC20 Pay) and a second/third native Pay are explicitly not
recommended — they would not test anything Tests 1/2/5 don't already cover, and the brief
itself asks for the minimum set with maximum coverage, not exhaustive repetition.

---

**Stopping here, per your instructions.** No code modified, no transaction executed by me, no
migration applied, no deployment, no `ledger_events` created. Waiting for you to perform the
recommended transactions and provide the transaction hashes per §10 before any further work.
