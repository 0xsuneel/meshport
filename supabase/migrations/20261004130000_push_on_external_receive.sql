-- Push notification for funds received at a MeshPort wallet from ANY
-- address (external wallets, exchanges, bridges). MeshPort→MeshPort Pay /
-- Chat payments already get a push from /api/chat (their rows carry
-- metadata.source = 'chat-api' and are skipped here). The indexer +
-- activity-consumer write these receive rows within ~2 minutes, so the
-- phone is notified even while the app is closed.
-- Tag 'payment-<hash>' matches the app's own in-app mirror of the same
-- deposit (lib/systemNotify.ts), so the phone keeps a single entry.

CREATE OR REPLACE FUNCTION public.push_on_external_receive()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_secret  text;
  v_user    text;
  v_from    text;
  v_name    text;
  v_hash    text;
  v_amount  text;
BEGIN
  IF NEW.activity_type <> 'receive' OR NEW.status IS DISTINCT FROM 'completed' THEN RETURN NEW; END IF;
  IF coalesce(NEW.metadata->>'source', '') = 'chat-api' THEN RETURN NEW; END IF;
  IF coalesce((NEW.metadata->>'backfilled')::boolean, false) THEN RETURN NEW; END IF;
  IF NEW.metadata ?| array['merchantOrder', 'merchantPayment', 'auto_convert', 'merchant'] THEN RETURN NEW; END IF;
  -- Only fresh events (a history backfill must not alert).
  IF NEW.created_at < now() - interval '30 minutes' THEN RETURN NEW; END IF;

  v_user := NEW.user_id;
  IF v_user IS NULL THEN
    SELECT u.id::text INTO v_user FROM public.users u WHERE lower(u.wallet_address) = lower(NEW.wallet_address) LIMIT 1;
  END IF;
  IF v_user IS NULL THEN RETURN NEW; END IF;

  BEGIN
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'p2p_push_secret';
  EXCEPTION WHEN OTHERS THEN
    v_secret := NULL;
  END;
  IF v_secret IS NULL THEN RETURN NEW; END IF;

  v_hash := lower(regexp_replace(coalesce(NEW.tx_hash, ''), '^(send_|recv_|bulk_|bulkrecv_)', ''));
  v_amount := rtrim(rtrim(NEW.amount::text, '0'), '.');
  v_from := lower(coalesce(NEW.counterparty_address, ''));
  IF v_from <> '' THEN
    SELECT u.username INTO v_name FROM public.users u WHERE lower(u.wallet_address) = v_from LIMIT 1;
  END IF;

  PERFORM net.http_post(
    url     := 'https://meshport.xyz/api/push?action=send-internal',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    body    := jsonb_build_object(
      'userId', v_user,
      'title',  'Received',
      'body',   '+' || v_amount || ' ' || coalesce(NEW.token_symbol, 'USDC') || ' from ' ||
                CASE
                  WHEN v_name IS NOT NULL THEN regexp_replace(v_name, '\.arc$', '') || '.arc'
                  WHEN length(v_from) > 12 THEN substr(v_from, 1, 6) || '…' || right(v_from, 4)
                  ELSE 'an external wallet'
                END,
      'tag',    'payment-' || v_hash,
      'url',    '/activity'
    )
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A push problem must never block recording the deposit.
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_push_on_external_receive ON public.activity;
CREATE TRIGGER trg_push_on_external_receive
  AFTER INSERT ON public.activity
  FOR EACH ROW EXECUTE FUNCTION public.push_on_external_receive();
