-- ═══════════════════════════════════════════════════════════════════════════
-- MeshPort P2P — persistent, server-driven notifications
--
-- Why this exists: p2pService.ts's existing notifyP2P() only ever writes
-- into the CALLING browser tab's own local Zustand store (see the check
-- `useAuthStore.getState().user?.id !== userId → return` in p2pService.ts).
-- That means a counterparty on a different device (the normal case — two
-- different people trading) never actually got notified at all; it only
-- ever appeared to work in same-browser/dev-multi-account testing.
--
-- Fix: move notification CREATION into the database itself, driven directly
-- off real p2p_trades writes — exactly the same "trigger is the actual
-- enforcement, JS is the UX layer" pattern this migration set already uses
-- for the dispute lock + audit log (20260729140000). This is what makes
-- "Automatically insert notifications whenever trade status changes" true
-- regardless of which code path (this app, an admin action, a future
-- integration) performed the write.
--
-- user_id is `text`, matching p2p_trades.buyer_id/seller_id's actual column
-- type (see 20260729150000's note — auth.uid() needs an explicit ::text
-- cast to compare against them).
--
-- RLS below is intentionally wide-open (`true`), matching every other table
-- in this app (users, p2p_trades, p2p_offers, push_subscriptions all use
-- `true` policies — see push_subscriptions' `push_subs_all`). This is not
-- an oversight: src/lib/chatService.ts has its own comment on exactly this
-- — this app's real sessions don't reliably carry a Supabase auth.uid() that
-- matches the app's own user id (anon-key REST calls, social-login users,
-- etc.), so an auth.uid()-scoped policy here would silently return zero
-- rows for everyone instead of erroring, which is worse than no RLS at all.
-- The actual access boundary is that rows can ONLY ever be created by the
-- SECURITY DEFINER trigger below — no client, with any key, can forge a
-- notification for another user — same trust model already used for
-- p2p_trades/p2p_offers.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL,
  type        text NOT NULL,
  title       text NOT NULL,
  message     text NOT NULL,
  trade_id    uuid REFERENCES public.p2p_trades(id) ON DELETE SET NULL,
  read        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON public.notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx  ON public.notifications (user_id, read) WHERE read = false;
CREATE INDEX IF NOT EXISTS notifications_trade_idx         ON public.notifications (trade_id);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Wide-open SELECT/UPDATE, matching push_subscriptions/users/p2p_trades/
-- p2p_offers (see comment above). INSERT/DELETE stay revoked from both
-- roles — that's the real boundary, not row ownership: only the trigger
-- (SECURITY DEFINER) can create a row, so nobody can forge one for another
-- user regardless of how open the read/update policies are.
REVOKE INSERT, DELETE ON public.notifications FROM anon, authenticated;

DROP POLICY IF EXISTS "notifications_select_own" ON public.notifications;
DROP POLICY IF EXISTS "notifications_update_own" ON public.notifications;
DROP POLICY IF EXISTS "notifications_all" ON public.notifications;
CREATE POLICY "notifications_all" ON public.notifications
  FOR ALL
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.notifications IS
  'Persistent, per-user notification feed — source of truth for the bell/notification-center UI. Populated exclusively by p2p_notify_trade_event() (trigger on p2p_trades); never written to directly by client code. Enabled for Supabase Realtime so the UI updates instantly without a refresh.';

-- ── Realtime ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
EXCEPTION
  WHEN duplicate_object THEN NULL; -- already added — safe to re-run this migration
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Trigger: insert notification rows whenever a trade is created or its
-- lifecycle state changes. Mirrors the same OLD/NEW classification style as
-- p2p_log_trade_audit() (20260729140000) — same inputs, different output
-- (a user-facing notification row instead of an audit entry).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.p2p_notify_trade_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

    -- Trade expired
    IF OLD.status IS DISTINCT FROM 'expired' AND NEW.status = 'expired' THEN
      INSERT INTO public.notifications (user_id, type, title, message, trade_id)
      VALUES (NEW.buyer_id, 'trade_expired', 'Trade Expired',
              'Your payment window closed before payment was marked sent.', NEW.id);
      INSERT INTO public.notifications (user_id, type, title, message, trade_id)
      VALUES (NEW.seller_id, 'trade_expired', 'Trade Expired',
              'The buyer''s payment window closed. Your offer is available again.', NEW.id);
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
$$;

DROP TRIGGER IF EXISTS trg_p2p_notify_trade_insert ON public.p2p_trades;
CREATE TRIGGER trg_p2p_notify_trade_insert
AFTER INSERT ON public.p2p_trades
FOR EACH ROW
EXECUTE FUNCTION public.p2p_notify_trade_event();

DROP TRIGGER IF EXISTS trg_p2p_notify_trade_update ON public.p2p_trades;
CREATE TRIGGER trg_p2p_notify_trade_update
AFTER UPDATE ON public.p2p_trades
FOR EACH ROW
EXECUTE FUNCTION public.p2p_notify_trade_event();

COMMENT ON FUNCTION public.p2p_notify_trade_event IS
  'Single source of truth for P2P notification creation. Fires on every p2p_trades INSERT (new buy/sell order placed) and UPDATE (payment marked, funds released, cancelled, expired, dispute opened/resolved, refund completed), inserting rows into public.notifications for the relevant part(y/ies). Runs regardless of which code path performed the write — the app, an admin action, or a direct PostgREST call.';

-- ─────────────────────────────────────────────────────────────────────────
-- Best-effort Web Push dispatch — fires immediately after a notification
-- row is inserted, so a user who isn't looking at the app right now still
-- gets an OS-level push (if they've granted permission — see
-- enablePushNotifications() in src/lib/pushNotifications.ts, which is what
-- populates push_subscriptions). Realtime (above) already covers the
-- "app open right now" case instantly; this covers "app closed / backgrounded".
--
-- Calls back into THIS app's EXISTING /api/push?action=send-internal
-- endpoint (see api/push.ts's handleSendInternal / PUSH_INTERNAL_SECRET) —
-- already built for exactly this "trusted backend infra, no user session to
-- attach a token from" case, so nothing new needs deploying on the API side.
--
-- SETUP — run once in the Supabase SQL editor after deploying this
-- migration:
--   select vault.create_secret('<SAME_VALUE_AS_PUSH_INTERNAL_SECRET>', 'p2p_push_secret');
-- using the SAME value already set as PUSH_INTERNAL_SECRET in Vercel's env
-- vars. APP_ORIGIN below is meshport.xyz — this app's real deployed origin
-- (set via a follow-up migration, 20260730_p2p_push_dispatch_relative_urls,
-- once the domain was known; this file has been updated in place to match
-- what's actually deployed rather than leaving two versions to reconcile).
-- ─────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.p2p_dispatch_push_for_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_secret text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'p2p_push_secret';
  EXCEPTION WHEN OTHERS THEN
    v_secret := NULL; -- vault secret not configured yet — skip push, Realtime still delivers in-app
  END;

  IF v_secret IS NOT NULL THEN
    PERFORM net.http_post(
      url     := 'https://meshport.xyz/api/push?action=send-internal',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
      body    := jsonb_build_object(
        'userId', NEW.user_id,
        'title',  NEW.title,
        'body',   NEW.message,
        'tag',    'p2p-' || NEW.type,
        'url',    CASE WHEN NEW.trade_id IS NOT NULL THEN '/p2p/trade/' || NEW.trade_id::text ELSE '/p2p' END
      )
    );
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a push-dispatch problem roll back the notification insert
  -- itself — the in-app bell/Realtime path must still work regardless.
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_p2p_dispatch_push ON public.notifications;
CREATE TRIGGER trg_p2p_dispatch_push
AFTER INSERT ON public.notifications
FOR EACH ROW
EXECUTE FUNCTION public.p2p_dispatch_push_for_notification();

COMMENT ON FUNCTION public.p2p_dispatch_push_for_notification IS
  'Best-effort Web Push dispatch for a newly-inserted notification row — calls https://meshport.xyz/api/push?action=send-internal (see api/push.ts, guarded by PUSH_INTERNAL_SECRET) so a user who is not currently looking at the app still gets an OS-level push, if they have previously granted permission. Push payload''s own `url` field stays relative (matching api/_lib/push.ts''s convention) since that''s consumed client-side by the service worker, not by net.http_post. Silently no-ops until the p2p_push_secret Vault secret is configured (select vault.create_secret(''<value matching PUSH_INTERNAL_SECRET>'', ''p2p_push_secret'')); the Realtime-driven in-app bell/toast keeps working either way.';
