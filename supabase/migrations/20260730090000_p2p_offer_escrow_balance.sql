-- ─────────────────────────────────────────────────────────────────────────
-- Adds escrow_balance to p2p_offers — a numeric mirror of what the
-- deployed P2PEscrow contract's getRemaining(offerKey) reports for this
-- offer at the moment it was last written. The contract itself remains
-- the actual source of truth (see p2pEscrowContract.ts's
-- getEscrowRemaining, which reads it live, no tx, no gas) — this column
-- exists purely so the app can show/store a balance without a live RPC
-- call on every offer list render, and so "how much did we deposit /
-- withdraw" has an audit trail sitting next to escrow_deposit_tx_hash and
-- escrow_withdraw_tx_hash.
--
-- Written in exactly two places (see src/lib/p2pService.ts):
--   • createOffer()               — set to the deposited amount right
--                                    after a successful on-chain deposit.
--   • cancelOfferAndWithdrawEscrow() — set to 0 right after a successful
--                                    on-chain withdrawal.
-- Not updated on every partial release against a sell offer's pool (that
-- would need a live contract read per release) — the contract's own
-- getRemaining() is the authoritative number if a precise mid-lifecycle
-- balance is ever needed; this column is a snapshot, not a live ledger.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE public.p2p_offers
  ADD COLUMN IF NOT EXISTS escrow_balance numeric(20, 6);

COMMENT ON COLUMN public.p2p_offers.escrow_balance IS
  'Snapshot of on-chain escrow remaining for this offer (native USDC, see P2PEscrow.sol getRemaining) as of the last deposit/withdrawal this app performed. Not live-synced on every partial release — the contract itself is the authoritative balance.';
