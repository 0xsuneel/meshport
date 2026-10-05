-- ─────────────────────────────────────────────────────────────────────────
-- P2P trade cancellation guard
--
-- Bug: cancelTrade() in src/lib/p2pService.ts previously flipped a trade's
-- status to 'cancelled' with no precondition check at all — either party
-- could cancel a trade at any point, including after the counterparty had
-- already fulfilled their obligation (buyer paid fiat, or seller deposited
-- escrow). The application layer now enforces this via canCancelTrade()
-- (see p2pService.ts), but that JS layer is trivially bypassable by any
-- client hitting PostgREST directly with a valid session — it is not a
-- real security boundary on its own. This trigger is the hard backstop:
-- the actual rule, enforced at the one place a client can't route around.
--
-- Rule (mirrors canCancelTrade() exactly):
--   - Once the buyer has marked payment sent (status = 'payment_sent'),
--     NEITHER party may cancel — only release or dispute from here.
--   - For a buy-offer trade, the seller's escrow deposit happens
--     synchronously as part of accepting the offer (createTrade), so by
--     the time the trade row exists the seller has already fulfilled
--     their obligation — the buyer may never cancel it. The seller (who
--     just deposited) may still cancel while the buyer hasn't paid yet,
--     same as a sell-offer trade before payment_sent.
--   - Either restriction is waived if the trade was already frozen by an
--     admin or has an open dispute BEFORE this update — that's the signal
--     an admin is actively resolving it, not a party sidestepping the rule.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.p2p_enforce_trade_cancellation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  is_privileged boolean;
  counterparty_fulfilled boolean;
BEGIN
  -- Only ever gate transitions INTO 'cancelled'. Every other status
  -- change (payment_sent, released/completed, expired, admin_frozen
  -- toggles, dispute fields, etc.) is untouched by this trigger.
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN

    -- An admin who has already frozen the trade, or a trade already under
    -- an open dispute, is exempt — that prior step is what signals a
    -- legitimate override rather than a party dodging the rule.
    is_privileged := (OLD.admin_frozen IS TRUE) OR (OLD.dispute_status = 'open');

    counterparty_fulfilled :=
      -- Sell-offer or buy-offer alike: buyer already paid.
      (OLD.status = 'payment_sent')
      -- Buy-offer: seller's escrow deposit already happened at trade
      -- creation. Only the seller themself (auth.uid() = seller_id) is
      -- still allowed to cancel here, before the buyer has paid — anyone
      -- else, including the buyer, is blocked.
      OR (OLD.offer_type = 'buy' AND auth.uid() IS DISTINCT FROM OLD.seller_id);

    IF counterparty_fulfilled AND NOT is_privileged THEN
      RAISE EXCEPTION
        'This trade can no longer be cancelled because the counterparty has already fulfilled their obligation. Please complete the trade or open a dispute.'
        USING ERRCODE = '22023'; -- invalid_parameter_value: closest standard code for a rejected state transition
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_p2p_trade_cancellation_guard ON public.p2p_trades;

CREATE TRIGGER trg_p2p_trade_cancellation_guard
BEFORE UPDATE ON public.p2p_trades
FOR EACH ROW
EXECUTE FUNCTION public.p2p_enforce_trade_cancellation();

COMMENT ON FUNCTION public.p2p_enforce_trade_cancellation IS
  'Hard backstop for P2P trade cancellation rules — blocks any UPDATE that sets status=cancelled once the counterparty has already fulfilled their obligation (buyer paid, or seller deposited escrow on a buy-offer trade), unless the trade is already admin-frozen or under an open dispute. Mirrors canCancelTrade() in src/lib/p2pService.ts; this is the layer that still holds even if that JS check is bypassed.';
