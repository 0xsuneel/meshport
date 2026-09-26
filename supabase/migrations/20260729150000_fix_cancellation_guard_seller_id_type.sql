-- ─────────────────────────────────────────────────────────────────────────
-- Fix: p2p_enforce_trade_cancellation() compares auth.uid() (uuid) directly
-- against OLD.seller_id — but p2p_trades.seller_id is actually `text`, not
-- `uuid` (confirmed via information_schema.columns). That comparison:
--
--   auth.uid() IS DISTINCT FROM OLD.seller_id
--
-- has no operator between uuid and text and throws
-- `42883: operator does not exist: text = uuid` the moment it's evaluated
-- — i.e. any time a BUY-offer trade cancellation is attempted (the branch
-- that reads OLD.offer_type = 'buy'). That means the seller-cancels-a-buy-
-- offer-trade-before-payment path has been silently broken since this
-- trigger was added in 20260729120000: every such cancel attempt errors
-- out instead of succeeding or being correctly rejected.
--
-- Fix: cast auth.uid() to text for this comparison, matching seller_id's
-- actual column type. No logic changes — same rule, now type-safe.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.p2p_enforce_trade_cancellation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  is_privileged boolean;
  counterparty_fulfilled boolean;
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN

    is_privileged := (OLD.admin_frozen IS TRUE) OR (OLD.dispute_status = 'open');

    counterparty_fulfilled :=
      (OLD.status = 'payment_sent')
      -- seller_id is `text` in this schema, auth.uid() is `uuid` — cast to
      -- compare. (This is the line that previously raised
      -- "operator does not exist: text = uuid".)
      OR (OLD.offer_type = 'buy' AND auth.uid()::text IS DISTINCT FROM OLD.seller_id);

    IF counterparty_fulfilled AND NOT is_privileged THEN
      RAISE EXCEPTION
        'This trade can no longer be cancelled because the counterparty has already fulfilled their obligation. Please complete the trade or open a dispute.'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.p2p_enforce_trade_cancellation IS
  'Hard backstop for P2P trade cancellation rules — blocks any UPDATE that sets status=cancelled once the counterparty has already fulfilled their obligation (buyer paid, or seller deposited escrow on a buy-offer trade), unless the trade is already admin-frozen or under an open dispute. Mirrors canCancelTrade() in src/lib/p2pService.ts. seller_id is text in this schema, hence the ::text cast on auth.uid() — see 20260729150000 for why.';
