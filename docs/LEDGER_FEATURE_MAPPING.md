# Ledger Feature Mapping

Status: design/audit only, companion to `docs/LEDGER_CANONICAL_EVENT_DESIGN.md` — read that
document first for the reasoning behind every column here. This is the reference table, not a
new argument.

**Column notes**:
- **Identity** always assumes the general shape `{chain_id}:{tx_hash}:{log_index}:{wallet_address}:{event_type}`
  (Phase 1 §6) unless noted otherwise.
- **Debit/Credit** is the `ledger_events.direction` value, not the `event_type` — restated
  separately since they're deliberately different axes (Phase 1 §13.1).
- **Failure/reorg** describes what happens to the ledger row (or the fact that none exists yet)
  under each of `chain_events.status` = `pending`/`reorged`, and `transaction_attempts.status`
  = `REVERTED`/`DROPPED`/`UNKNOWN`.

| # | Feature | Raw chain event(s) | Financial meaning | Ledger event type | Debit/Credit | Identity | Activity projection | Notification | Failure/reorg behavior |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Pay | 1 Transfer log (or native value transfer) | Sender pays recipient | `DEBIT` (sender), `CREDIT` (recipient) | debit / credit | Standard key, two rows (different `wallet_address`) sharing `chain_id`+`tx_hash`+`log_index` | 2 separate Activity rows (one per wallet), no grouping | 1 notification for recipient (`payment_confirmed:<intent_id>` or event_key fallback) | `pending`/`UNKNOWN` -> no ledger row yet; `REVERTED`/`DROPPED` -> never created; reorg on a `POSTED` row -> `REVERSED` |
| 2 | Receive | Same event as Pay's recipient leg — not a distinct raw event | Recipient's side of Pay/Swap/BulkPay/etc. | `CREDIT` (no distinct type) | credit | Same as the originating feature's credit leg | Same row as the originating feature's recipient-side Activity | Same as originating feature | Same as originating feature |
| 3 | Swap | 2 Transfer logs, same wallet, different token contracts (or 1 native + 1 ERC-20) | Input leaves, output arrives | `SWAP_DEBIT`, `SWAP_CREDIT` | debit, credit | Two rows, same `wallet_address`, different `log_index`/`token_address`, same `transaction_intent_id` once intents exist | **Grouped**: both legs -> 1 Activity row ("100 USDC -> 98.31 EURC") | 1 notification ("Swap Complete") | `UNKNOWN` output leg -> no `SWAP_CREDIT` yet, must not become generic `CREDIT` (§7.2); `REVERTED` -> neither leg created; reorg -> both legs `REVERSED` together (same intent) |
| 4 | Multichain Transfer — UB | Source-chain debit-shaped tx (deposit), UB-internal settlement (implementation event, no row), destination-chain Transfer (payout) | Payer funds UB, UB pays out on destination chain | `UB_DEPOSIT`, `UB_SPEND` (payer side); `CREDIT` (destination recipient, feature-agnostic) | debit, debit; credit | `UB_DEPOSIT`/`UB_SPEND` share `transaction_intent_id`; destination `CREDIT` is its own row, own/no intent | Payer sees 1 grouped "Sent via Unified Balance" row (UB_DEPOSIT+UB_SPEND); recipient sees a normal receive row | 1 notification to payer on completion; 1 to recipient on their credit | `UB_SPEND` `UNKNOWN`/failed after `UB_DEPOSIT` confirmed -> `UB_DEPOSIT_CONFIRMED` / `UB_SPEND_FAILED` recovery state (original brief's Phase 10), no `UB_SPEND` ledger row until resolved |
| 5 | Multichain Transfer — CCTP V2 | Source `DepositForBurn` (burn), `MessageReceived` (implementation event, no row), destination mint Transfer | Payer burns on source, mint arrives on Arc | `BRIDGE_BURN` (source), `BRIDGE_MINT` (destination) | debit, credit | Two rows, different `chain_id`, same `transaction_intent_id` (feature='multichain_transfer') | Grouped into 1 "Bridged via CCTP" row if same intent; else 2 rows | 1 notification on destination mint confirmation | Burn `REVERTED` -> no `BRIDGE_BURN`; mint `UNKNOWN` -> no `BRIDGE_MINT` yet; §8's address(0) exclusivity applies |
| 6 | Multichain Claim — CCTP V2 | Same destination mint Transfer as #5, `from = address(0)` | User-initiated recovery of an untracked/stuck burn | `BRIDGE_MINT` — **exactly once**, never also generic `CREDIT` | credit | Correlated via `claims.transaction_intent_id`, not a fresh intent | 1 Activity row (`activity_type='claim'`, unchanged from today's shape) | 1 notification ("Claim Complete") | §8 governs exclusivity; claim-worker's own state machine (`submitted`/`bridging`/`completed`/`failed`) is unchanged and authoritative for claim progress |
| 7 | BulkPay — Multicall3 | N Transfer logs, 1 tx, N distinct `log_index` values, N recipient wallets | Payer pays N recipients in one tx | `DEBIT` x N (payer), `CREDIT` x N (recipients) | debit x N, credit x N | Standard key per log — N distinct `event_key`s per side, §5/§6 | Payer: 1 grouped "Bulk Payment to N people" row; each recipient: their own 1-row credit | 1 notification per recipient; 1 summary notification to payer | Per-log-index atomicity (§6) — partial batch failure processes independently, no all-or-nothing requirement; Multicall3 revert (whole tx fails) -> zero ledger rows for any log |
| 8 | ChatPay | Same shape as Pay (#1) | Payment sent via chat | `DEBIT`, `CREDIT` (no new type) | debit, credit | Same as Pay; `transaction_intents.metadata` carries chat message reference | Same as Pay, plus a chat-message-projection reference (`transaction_id` link, per original brief) | Same as Pay | Same as Pay |
| 9 | P2P escrow deposit | 1 Transfer, trader wallet -> escrow contract | Funds committed to a trade, not yet resolved | `ESCROW_LOCK` | debit | Standard key; `transaction_intent_id` feature='p2p', operation='escrow_deposit' | 1 Activity row ("Funds Locked in Escrow") | 1 notification | `UNKNOWN`/`REVERTED` -> no `ESCROW_LOCK` row; trade state (`p2p_trades`) stays `CREATED` until confirmed |
| 10 | P2P escrow release | 1 Transfer, escrow contract -> buyer | Trade completed, funds released to buyer | `ESCROW_RELEASE` | credit | Standard key; sender = escrow contract (§2 third signal + `p2p_trades` state to distinguish from refund, §9) | 1 Activity row for buyer ("Trade Completed") | 1 notification to buyer (and seller, trade-completion notice) | Requires `p2p_trades` read to classify at all (§9) — without it, falls back to generic `CREDIT`, a real, disclosed gap until that dependency is built |
| 11 | P2P escrow refund | 1 Transfer, escrow contract -> original locker | Trade did not complete, funds returned | `ESCROW_REFUND` | credit | Same as #10, disambiguated by `p2p_trades` showing cancelled/refunded outcome | 1 Activity row ("Escrow Refunded") | 1 notification | Same dependency and same disclosed gap as #10 |

---

## Notes on rows 10/11 specifically

These are the only two rows in this table whose classification cannot be fully resolved from
`chain_events` + `transaction_intents` alone (see `docs/LEDGER_CANONICAL_EVENT_DESIGN.md` §9).
Until the Ledger Interpreter's P2P path is built with a working `p2p_trades` read, a Transfer
from the escrow contract would only be reliably excluded from generic `CREDIT` (via the
sender-address fallback, once a real escrow address is configured per the Claim-Recovery fix's
`extra` mechanism) — it would **not** yet correctly distinguish release from refund. This is
listed as a known, bounded gap for the P2P ledger phase specifically, not a flaw in the general
design.

## Notes on row 4 (UB) specifically

This is the one feature where this design's confidence is lowest — no UB-specific Activity
writer was found anywhere in the 16-writer catalog (`docs/ACTIVITY_WRITER_AUDIT.md` P2 item),
meaning UB's actual on-chain shape (does Circle's UB implementation even emit a distinct,
observable "deposit confirmed" event separate from the destination payout? is there truly an
internal-only rebalancing step, or was that speculative?) was not independently verified against
real UB transaction data in this design pass. The `UB_DEPOSIT`/`UB_SPEND` event types already
exist in the Phase 1 schema (inherited, not invented here), but this table's description of
their exact triggering conditions should be treated as the best available design given current
evidence, not a verified-against-live-data fact the way, say, the BulkPay/Multicall3 row is
(which has actual traced production data behind it, `chain_events` tx `0x435d804c…`).
