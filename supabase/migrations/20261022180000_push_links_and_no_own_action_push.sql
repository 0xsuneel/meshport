-- Phone notifications: open the thing they are about, and none for your own
-- actions.
--
-- Tapping a pushed notification opened /merchant or /p2p for anything that
-- wasn't a trade. It now opens what it is about: Business → Payments for a
-- payment received, Business → Settlements for USDC that arrived on another
-- chain, Activity for a refund you received, Business for an approval or a
-- staff invite.
--
-- The payer was also notified of their own payment ("You paid $5.00 USDC to
-- Royal Salons", merchant_order_paid), a business of a refund it sent
-- (merchant_refund_sent), of its own USDC reaching another chain ("Your
-- USDC arrived on …") and of their own part payment ("You paid $2 of $5"). Those are no longer pushed, and are stored already
-- read: they stay in the list as a record without alerting anyone. The app
-- skips its toast / phone copy for them too (lib/systemNotify.ts).
create or replace function public.p2p_dispatch_push_for_notification()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_secret text;
begin
  -- Your own action: on screen already. Kept, read, not pushed.
  if NEW.type in ('merchant_order_paid', 'merchant_refund_sent')
     or (NEW.type = 'merchant_chain_payment' and NEW.title ilike 'Your USDC arrived%')
     -- The payer's copy of a partial payment ("You paid $2 of $5 …").
     or (NEW.type = 'merchant_payment_partial' and NEW.message ilike 'You paid%') then
    update public.notifications set read = true where id = NEW.id;
    return NEW;
  end if;

  begin
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'p2p_push_secret';
  exception when others then
    v_secret := null; -- vault secret not configured yet - skip push, Realtime still delivers in-app
  end;

  if v_secret is not null then
    perform net.http_post(
      url     := 'https://meshport.xyz/api/push?action=send-internal',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
      body    := jsonb_build_object(
        'userId', NEW.user_id,
        'title',  NEW.title,
        'body',   NEW.message,
        'tag',    'n-' || NEW.id::text,
        'url',    case
                    when NEW.trade_id is not null then '/p2p/trade/' || NEW.trade_id::text
                    when NEW.type in ('merchant_payment_received', 'merchant_payment_partial', 'merchant_payment_arriving') then '/business?tab=payments'
                    when NEW.type in ('merchant_chain_payment', 'merchant_ledger_credited', 'merchant_ledger_moving', 'merchant_funds_moved') then '/business?tab=settlements'
                    when NEW.type in ('merchant_approved', 'business_staff_invite') then '/business'
                    when NEW.type in ('merchant_refund', 'merchant_order_completed') then '/activity'
                    -- The customer's reminder: bills are paid from chat.
                    when NEW.type = 'merchant_bill_reminder' then '/chat'
                    when NEW.type like 'merchant_%' or NEW.type like 'business_%' then '/business'
                    else '/notifications'
                  end
      )
    );
  end if;
  return NEW;
exception when others then
  -- Never let a push-dispatch problem roll back the notification insert
  -- itself - the in-app bell/Realtime path must still work regardless.
  return NEW;
end;
$function$;

-- Already-sent ones: stored read like new ones.
update public.notifications set read = true
 where read = false
   and (type in ('merchant_order_paid', 'merchant_refund_sent')
        or (type = 'merchant_chain_payment' and title ilike 'Your USDC arrived%')
        or (type = 'merchant_payment_partial' and message ilike 'You paid%'));
