-- Real accuracy bug found while looking at this: the previous trade_expired
-- message always said "the buyer's payment window closed" — even when the
-- trade actually expired at 'awaiting_seller_confirmation' (the SELLER
-- never registered it on-chain, before the buyer's payment window ever
-- started). Fixed by branching on OLD.status, which tells us exactly which
-- party's obligation was outstanding when the trade expired:
--   - awaiting_seller_confirmation -> seller never confirmed/registered
--   - waiting_for_buyer            -> buyer never marked payment sent
create or replace function public.p2p_notify_trade_event()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_offer_owner   text;
  v_offer_type    text;
BEGIN
  -- ── New trade created — "buy/sell order placed on their offer" ─────────
  -- The trade's own offer_type is the OFFER's type, not the accepting
  -- user's action — someone accepting a 'sell' offer is placing a BUY
  -- order (and vice versa), so the wording below matches what the offer
  -- owner actually experiences: a buy order landing on their sell offer.
  IF TG_OP = 'INSERT' THEN
    SELECT user_id, offer_type INTO v_offer_owner, v_offer_type
    FROM public.p2p_offers WHERE id = NEW.offer_id;

    IF v_offer_owner IS NOT NULL THEN
      INSERT INTO public.notifications (user_id, type, title, message, trade_id)
      VALUES (
        v_offer_owner,
        CASE WHEN v_offer_type = 'sell' THEN 'buy_order_placed' ELSE 'sell_order_placed' END,
        CASE WHEN v_offer_type = 'sell' THEN 'New Buy Order' ELSE 'New Sell Order' END,
        format('A new %s order for %s USDC was placed on your %s offer.',
               CASE WHEN v_offer_type = 'sell' THEN 'buy' ELSE 'sell' END,
               NEW.amount_usdc, v_offer_type),
        NEW.id
      );
    END IF;
    RETURN NEW;
  END IF;

  -- ── Existing trade updated ──────────────────────────────────────────────
  IF TG_OP = 'UPDATE' THEN

    -- Seller registered the trade on-chain (signed registerTrade with
    -- their own wallet, as required by the escrow contract) — the buyer's
    -- cue that it's now their turn to pay. This is the one real gap: every
    -- other status transition already had a notification case, this one
    -- never did.
    IF OLD.status = 'awaiting_seller_confirmation' AND NEW.status = 'waiting_for_buyer' THEN
      INSERT INTO public.notifications (user_id, type, title, message, trade_id)
      VALUES (NEW.buyer_id, 'seller_confirmed', 'Seller Confirmed',
              format('The seller registered your trade on-chain. You can now make your payment of %s USDC.', NEW.amount_usdc), NEW.id);
    END IF;

    -- Buyer marked payment as completed
    IF OLD.status = 'waiting_for_buyer' AND NEW.status = 'payment_sent' THEN
      INSERT INTO public.notifications (user_id, type, title, message, trade_id)
      VALUES (NEW.seller_id, 'payment_marked_completed', 'Payment Marked as Sent',
              format('The buyer marked payment as completed for %s USDC. Review and release when ready.', NEW.amount_usdc), NEW.id);
    END IF;

    -- Seller confirmed payment & released crypto / funds released — one
    -- real transition covers both ("Seller confirms payment and releases
    -- crypto" and "Funds are released" are the same event from two angles),
    -- so a single notification is sent to avoid duplicate noise for what
    -- is, on the buyer's side, one moment.
    IF OLD.status = 'payment_sent' AND NEW.status IN ('released', 'completed') THEN
      INSERT INTO public.notifications (user_id, type, title, message, trade_id)
      VALUES (NEW.buyer_id, 'funds_released', 'Funds Released',
              format('The seller confirmed your payment and released %s USDC to your wallet.', NEW.amount_usdc), NEW.id);
    END IF;

    -- Trade cancelled — notify whichever party did NOT still have the row
    -- open in front of them (both parties get it; cheap and avoids having
    -- to know who clicked Cancel from inside this trigger).
    IF OLD.status IS DISTINCT FROM 'cancelled' AND NEW.status = 'cancelled' THEN
      INSERT INTO public.notifications (user_id, type, title, message, trade_id)
      VALUES (NEW.buyer_id, 'trade_cancelled', 'Trade Cancelled',
              format('Your trade for %s USDC was cancelled.', NEW.amount_usdc), NEW.id);
      INSERT INTO public.notifications (user_id, type, title, message, trade_id)
      VALUES (NEW.seller_id, 'trade_cancelled', 'Trade Cancelled',
              format('Your trade for %s USDC was cancelled.', NEW.amount_usdc), NEW.id);

      -- Refund completed — only the real refund case: a buy-offer trade's
      -- seller (the accepting party) deposited trade-specific escrow at
      -- accept time (see createTrade() in p2pService.ts) and gets it
      -- refunded via escrowProvider.refund() on cancel. A sell-offer
      -- trade's escrow lives at the OFFER level and was never withdrawn in
      -- the first place, so there is nothing to "refund" there.
      IF NEW.offer_type = 'buy' THEN
        INSERT INTO public.notifications (user_id, type, title, message, trade_id)
        VALUES (NEW.seller_id, 'refund_completed', 'Refund Completed',
                format('Your escrowed %s USDC was refunded to your wallet.', NEW.amount_usdc), NEW.id);
      END IF;
    END IF;

    -- Trade expired — REASON-SPECIFIC per whose obligation was outstanding.
    -- OLD.status tells us exactly which stage it died at:
    --   awaiting_seller_confirmation -> the SELLER never confirmed/
    --     registered it on-chain in time (buyer's payment window never
    --     even started)
    --   waiting_for_buyer -> the BUYER never marked payment sent in time
    --     (this is the only case the old, always-buyer-blaming message
    --     was actually correct for)
    IF OLD.status IS DISTINCT FROM 'expired' AND NEW.status = 'expired' THEN
      IF OLD.status = 'awaiting_seller_confirmation' THEN
        INSERT INTO public.notifications (user_id, type, title, message, trade_id)
        VALUES (NEW.buyer_id, 'trade_expired', 'Trade Expired',
                format('The seller didn''t confirm this trade for %s USDC in time, so it expired.', NEW.amount_usdc), NEW.id);
        INSERT INTO public.notifications (user_id, type, title, message, trade_id)
        VALUES (NEW.seller_id, 'trade_expired', 'Trade Expired',
                format('You didn''t confirm this trade for %s USDC in time, so it expired. Your offer is available again.', NEW.amount_usdc), NEW.id);
      ELSIF OLD.status = 'waiting_for_buyer' THEN
        INSERT INTO public.notifications (user_id, type, title, message, trade_id)
        VALUES (NEW.buyer_id, 'trade_expired', 'Trade Expired',
                format('You didn''t mark payment sent for %s USDC in time, so this trade expired.', NEW.amount_usdc), NEW.id);
        INSERT INTO public.notifications (user_id, type, title, message, trade_id)
        VALUES (NEW.seller_id, 'trade_expired', 'Trade Expired',
                format('The buyer didn''t mark payment sent for %s USDC in time, so this trade expired. Your offer is available again.', NEW.amount_usdc), NEW.id);
      ELSE
        -- Defensive fallback for any other prior status — generic wording,
        -- same as the original behavior, rather than guessing a reason.
        INSERT INTO public.notifications (user_id, type, title, message, trade_id)
        VALUES (NEW.buyer_id, 'trade_expired', 'Trade Expired',
                format('Your trade for %s USDC expired.', NEW.amount_usdc), NEW.id);
        INSERT INTO public.notifications (user_id, type, title, message, trade_id)
        VALUES (NEW.seller_id, 'trade_expired', 'Trade Expired',
                format('Your trade for %s USDC expired.', NEW.amount_usdc), NEW.id);
      END IF;
    END IF;

    -- Dispute opened — notify the counterparty (whichever party is not
    -- reflected in dispute_reason's author; simplest correct rule is "notify
    -- both, since either party can be the one who opens it and the other
    -- always needs to know").
    IF OLD.dispute_status IS DISTINCT FROM 'open' AND NEW.dispute_status = 'open' THEN
      INSERT INTO public.notifications (user_id, type, title, message, trade_id)
      VALUES (NEW.buyer_id, 'dispute_opened', 'Dispute Opened',
              'A dispute was opened on your trade — our team will review it shortly.', NEW.id);
      INSERT INTO public.notifications (user_id, type, title, message, trade_id)
      VALUES (NEW.seller_id, 'dispute_opened', 'Dispute Opened',
              'A dispute was opened on your trade — our team will review it shortly.', NEW.id);
    END IF;

    -- Dispute resolved
    IF OLD.dispute_status = 'open' AND NEW.dispute_status IN ('resolved_buyer', 'resolved_seller') THEN
      INSERT INTO public.notifications (user_id, type, title, message, trade_id)
      VALUES (NEW.buyer_id, 'dispute_resolved', 'Dispute Resolved',
              format('Your dispute was resolved in the %s''s favor.', CASE WHEN NEW.dispute_status = 'resolved_buyer' THEN 'buyer' ELSE 'seller' END), NEW.id);
      INSERT INTO public.notifications (user_id, type, title, message, trade_id)
      VALUES (NEW.seller_id, 'dispute_resolved', 'Dispute Resolved',
              format('Your dispute was resolved in the %s''s favor.', CASE WHEN NEW.dispute_status = 'resolved_buyer' THEN 'buyer' ELSE 'seller' END), NEW.id);
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$function$;
