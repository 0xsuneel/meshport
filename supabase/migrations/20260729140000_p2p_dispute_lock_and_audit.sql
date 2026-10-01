-- ─────────────────────────────────────────────────────────────────────────
-- P2P disputed-trade lock + audit trail
--
-- Problem this closes:
--   The app-layer already tries to stop a disputed trade from moving
--   (canCancelTrade() checks disputeStatus, markPaymentSent()/releaseTrade()
--   check adminFrozen), but none of that is a real security boundary on its
--   own — any client with a valid session can PATCH p2p_trades directly via
--   PostgREST and skip the JS entirely. Two concrete gaps this migration
--   closes:
--
--   1. The existing cancellation-guard trigger (see migration
--      20260729120000) EXEMPTS a trade from its "counterparty fulfilled"
--      block once dispute_status = 'open' — but that exemption was written
--      to let an ADMIN force-cancel a disputed trade, and it never actually
--      checks who is performing the update. Today, a buyer or seller could
--      cancel their own disputed trade via a direct PATCH, because the
--      trigger only cares about fulfillment state, not disputed state.
--   2. Nothing at the DB layer stops a party from doing ANYTHING else to a
--      disputed trade either — marking payment again, forcing a release,
--      or (if a future code path ever adds one) editing/restarting it.
--
-- Fix: once dispute_status = 'open', this trigger blocks EVERY update to
-- the trade's business-state columns unless the actor is a recognised
-- admin (public.admin_users — the same table isAdminUser()/adminSignIn()
-- already check in adminSupabase.ts, and the same pattern
-- support_tickets_admin_all already uses in
-- 20260711000000_create_support_tickets.sql). This is what actually
-- enforces "only an admin/arbitrator may resolve the dispute" — the
-- application layer's checks are UX, this is the backstop.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.p2p_enforce_dispute_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  is_admin boolean;
  business_state_changed boolean;
BEGIN
  -- Only ever gate a row that was ALREADY disputed before this write.
  -- Opening a dispute in the first place (OLD.dispute_status <> 'open') is
  -- untouched — that's the one transition into the locked state, not out
  -- of it, and stays governed by openDispute()'s own rules.
  IF OLD.dispute_status IS DISTINCT FROM 'open' THEN
    RETURN NEW;
  END IF;

  -- Chat messages, ratings, etc. live in other tables and are unaffected
  -- by this trigger. Here we only care whether anything on the TRADE row
  -- itself — the fields every release/cancel/pay/edit path would need to
  -- touch — is changing. A no-op UPDATE (e.g. a client re-saving the same
  -- values) is harmless and left alone.
  business_state_changed :=
    NEW.status              IS DISTINCT FROM OLD.status
    OR NEW.dispute_status    IS DISTINCT FROM OLD.dispute_status
    OR NEW.admin_frozen      IS DISTINCT FROM OLD.admin_frozen
    OR NEW.cancel_reason     IS DISTINCT FROM OLD.cancel_reason
    OR NEW.admin_note        IS DISTINCT FROM OLD.admin_note
    OR NEW.tx_hash           IS DISTINCT FROM OLD.tx_hash
    OR NEW.payment_sent_at   IS DISTINCT FROM OLD.payment_sent_at
    OR NEW.released_at       IS DISTINCT FROM OLD.released_at
    OR NEW.completed_at      IS DISTINCT FROM OLD.completed_at
    OR NEW.dispute_reason    IS DISTINCT FROM OLD.dispute_reason;

  IF NOT business_state_changed THEN
    RETURN NEW;
  END IF;

  is_admin := EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = auth.uid());

  IF NOT is_admin THEN
    RAISE EXCEPTION
      'This trade is currently under dispute and is locked until an administrator resolves it.'
      USING ERRCODE = '22023'; -- invalid_parameter_value: rejected state transition, same code the cancellation guard uses
  END IF;

  RETURN NEW;
END;
$$;

-- Named to sort BEFORE the cancellation-guard trigger alphabetically so the
-- dispute lock is the first thing evaluated, though functionally either
-- order is safe — both are pure BEFORE-UPDATE guards that only ever raise,
-- never rewrite NEW.
DROP TRIGGER IF EXISTS trg_p2p_trade_dispute_lock ON public.p2p_trades;

CREATE TRIGGER trg_p2p_trade_dispute_lock
BEFORE UPDATE ON public.p2p_trades
FOR EACH ROW
EXECUTE FUNCTION public.p2p_enforce_dispute_lock();

COMMENT ON FUNCTION public.p2p_enforce_dispute_lock IS
  'Hard backstop for disputed trades: once dispute_status = open, blocks ANY update to a trade''s business-state columns (status, dispute fields, admin_frozen, cancel/release/payment timestamps, tx_hash) from anyone who is not in admin_users. This is the actual enforcement of "only an admin may resolve a dispute" — canCancelTrade()/markPaymentSent()/releaseTrade() in p2pService.ts are the UX layer, this is what still holds if a client bypasses them.';

-- ─────────────────────────────────────────────────────────────────────────
-- Audit trail — append-only log of every state change on a p2p_trades row.
--
-- Fired AFTER UPDATE, so it only ever records writes that actually made it
-- past both guard triggers above and the cancellation-guard trigger — i.e.
-- every real release, cancel, payment confirmation, refund-driven
-- cancellation, freeze/unfreeze, and dispute open/resolve is captured with
-- who did it (auth.uid()) and whether they were an admin at the time.
-- Blocked attempts never reach here at all — they're rejected (and rolled
-- back) by the BEFORE triggers, which is the actual protection; this table
-- is the record of what was legitimately allowed through.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.p2p_trade_audit_log (
  id                  bigint generated always as identity primary key,
  trade_id            uuid NOT NULL REFERENCES public.p2p_trades(id) ON DELETE CASCADE,
  actor_id            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  is_admin_actor      boolean NOT NULL DEFAULT false,
  action              text NOT NULL,
  old_status          text,
  new_status          text,
  old_dispute_status  text,
  new_dispute_status  text,
  old_admin_frozen    boolean,
  new_admin_frozen    boolean,
  occurred_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS p2p_trade_audit_log_trade_idx ON public.p2p_trade_audit_log (trade_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS p2p_trade_audit_log_actor_idx ON public.p2p_trade_audit_log (actor_id, occurred_at DESC);

ALTER TABLE public.p2p_trade_audit_log ENABLE ROW LEVEL SECURITY;

-- No client ever INSERTs here directly — only the SECURITY DEFINER trigger
-- function below writes rows, so app-layer code cannot forge or skip an
-- audit entry no matter which p2pService.ts function it calls (or bypasses).
REVOKE INSERT, UPDATE, DELETE ON public.p2p_trade_audit_log FROM anon, authenticated;

DROP POLICY IF EXISTS "p2p_trade_audit_log_select_admin" ON public.p2p_trade_audit_log;
CREATE POLICY "p2p_trade_audit_log_select_admin" ON public.p2p_trade_audit_log
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = auth.uid()));

-- Trade participants can see their own trade's audit trail too (transparency
-- — "why is my trade locked/who released it" shouldn't require a support
-- ticket), but only for trades they're actually a party to.
DROP POLICY IF EXISTS "p2p_trade_audit_log_select_party" ON public.p2p_trade_audit_log;
CREATE POLICY "p2p_trade_audit_log_select_party" ON public.p2p_trade_audit_log
  FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.p2p_trades t
    WHERE t.id = trade_id AND (t.buyer_id::text = auth.uid()::text OR t.seller_id::text = auth.uid()::text)
  ));

CREATE OR REPLACE FUNCTION public.p2p_log_trade_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_admin   boolean;
  v_action  text;
BEGIN
  IF NEW.status             IS NOT DISTINCT FROM OLD.status
     AND NEW.dispute_status IS NOT DISTINCT FROM OLD.dispute_status
     AND NEW.admin_frozen   IS NOT DISTINCT FROM OLD.admin_frozen THEN
    RETURN NEW; -- nothing audit-worthy changed on this write
  END IF;

  v_admin := EXISTS (SELECT 1 FROM public.admin_users a WHERE a.id = v_actor);

  v_action := CASE
    WHEN OLD.dispute_status IS DISTINCT FROM 'open' AND NEW.dispute_status = 'open' THEN 'dispute_opened'
    WHEN OLD.dispute_status = 'open' AND NEW.dispute_status IN ('resolved_buyer', 'resolved_seller') THEN 'dispute_resolved'
    WHEN OLD.status IS DISTINCT FROM 'released'  AND NEW.status = 'released'  THEN 'release_claimed'
    WHEN OLD.status IS DISTINCT FROM 'completed' AND NEW.status = 'completed' THEN 'funds_released'
    WHEN OLD.status IS DISTINCT FROM 'cancelled' AND NEW.status = 'cancelled' THEN 'cancelled'
    WHEN OLD.status IS DISTINCT FROM 'payment_sent' AND NEW.status = 'payment_sent' THEN 'payment_confirmed'
    WHEN OLD.status IS DISTINCT FROM 'expired' AND NEW.status = 'expired' THEN 'expired'
    WHEN NEW.admin_frozen IS DISTINCT FROM OLD.admin_frozen THEN (CASE WHEN NEW.admin_frozen THEN 'frozen' ELSE 'unfrozen' END)
    ELSE 'status_update'
  END;

  INSERT INTO public.p2p_trade_audit_log
    (trade_id, actor_id, is_admin_actor, action, old_status, new_status, old_dispute_status, new_dispute_status, old_admin_frozen, new_admin_frozen)
  VALUES
    (NEW.id, v_actor, v_admin, v_action, OLD.status, NEW.status, OLD.dispute_status, NEW.dispute_status, OLD.admin_frozen, NEW.admin_frozen);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_p2p_trade_audit_log ON public.p2p_trades;

CREATE TRIGGER trg_p2p_trade_audit_log
AFTER UPDATE ON public.p2p_trades
FOR EACH ROW
EXECUTE FUNCTION public.p2p_log_trade_audit();

COMMENT ON TABLE public.p2p_trade_audit_log IS
  'Append-only audit trail of every real state change on p2p_trades — release, cancel, payment confirmation, refund-driven cancellation, freeze/unfreeze, dispute open/resolve. Written exclusively by the p2p_log_trade_audit() trigger (SECURITY DEFINER), never directly by client code, so it cannot be skipped or forged by whichever p2pService.ts path (or a direct PostgREST call) performed the update.';
