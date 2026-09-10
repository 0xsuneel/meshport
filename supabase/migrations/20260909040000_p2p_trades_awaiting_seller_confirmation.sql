-- Sell-offer trades cannot legally call registerTrade from the buyer's
-- device (the contract requires msg.sender == the offer's actual escrow
-- depositor, i.e. the seller — see P2PMeshportEscrowV2.sol's registerTrade).
-- This new status represents the real gap between "buyer accepted" and
-- "seller has signed registerTrade with their own wallet", so the app can
-- stop pretending that step already happened. See createTrade() and
-- confirmSellTradeOnChain() in src/lib/p2pService.ts for the full story.
--
-- NOTE: this constraint change was already applied directly to the live
-- project (cvvpzfvzweszuuxvaayb) during the fix session — this file exists
-- so a fresh clone/deploy of this repo stays in sync with that change.
alter table p2p_trades drop constraint p2p_trades_status_check;
alter table p2p_trades add constraint p2p_trades_status_check
  check (status = any (array['awaiting_seller_confirmation'::text, 'waiting_for_buyer'::text, 'payment_sent'::text, 'released'::text, 'completed'::text, 'cancelled'::text, 'expired'::text]));
