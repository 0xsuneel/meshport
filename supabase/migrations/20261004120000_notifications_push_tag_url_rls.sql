-- Notification push + access fixes.
--  * tag: one per notification row ('n-<id>'). The old 'p2p-<type>' tag made
--    a second trade / merchant payment silently replace the first banner.
--  * url: merchant notifications (no trade_id) open the merchant page, not /p2p.
--  * RLS: notifications.user_id is users.id; match it through the session's
--    linked account (p2p_current_user_id(), same as the p2p tables), keeping
--    the old auth.uid() match so nothing that works today stops working.

CREATE OR REPLACE FUNCTION public.p2p_dispatch_push_for_notification()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        'tag',    'n-' || NEW.id::text,
        'url',    CASE
                    WHEN NEW.trade_id IS NOT NULL THEN '/p2p/trade/' || NEW.trade_id::text
                    WHEN NEW.type LIKE 'merchant_%' THEN '/merchant'
                    ELSE '/p2p'
                  END
      )
    );
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a push-dispatch problem roll back the notification insert
  -- itself — the in-app bell/Realtime path must still work regardless.
  RETURN NEW;
END;
$function$;

ALTER POLICY notifications_select_owner ON public.notifications
  USING ((auth.uid())::text = user_id OR user_id = public.p2p_current_user_id());

ALTER POLICY notifications_update_owner ON public.notifications
  USING ((auth.uid())::text = user_id OR user_id = public.p2p_current_user_id())
  WITH CHECK ((auth.uid())::text = user_id OR user_id = public.p2p_current_user_id());
