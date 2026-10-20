-- A Shop QR payment (the customer scans the store's fixed QR and types the
-- amount; shop_open_order makes an order with via = 'shop_qr') was named like
-- a merchant's request from Receive: "Requested #108 Payment Received" /
-- "Requested Payment Paid #108". Nobody requested it - it's a payment:
--   receiver: Payment #108 Received      payer: Payment Paid #108
-- Same wording as the app (src/lib/orderLabels.ts, kind 'shop').
--
--  * merchant_order_title / merchant_order_received_title take kind 'shop';
--  * the payment notifications pass 'shop' for a Shop QR order (the live
--    trigger body otherwise unchanged);
--  * activity rows carry merchantVia so the app can title them, and existing
--    Shop QR rows get it now.

create or replace function public.merchant_order_title(p_kind text, p_personal boolean, p_order text, p_paid boolean)
returns text language sql immutable set search_path = '' as $$
  select case
      when p_kind = 'invoice' then (case when p_paid then 'Paid Bill ' else 'Bill ' end)
      when p_kind = 'shop' then (case when p_paid then 'Payment Paid ' else 'Payment ' end)
      when coalesce(p_personal, true) then (case when p_paid then 'Request Amount Paid ' else 'Request ' end)
      else (case when p_paid then 'Requested Payment Paid ' else 'Requested Payment ' end)
    end || coalesce(public.merchant_order_display(p_order), '')
$$;

create or replace function public.merchant_order_received_title(p_kind text, p_personal boolean, p_order text)
returns text language sql immutable set search_path = '' as $$
  select case
      when p_kind = 'invoice' then 'Bill ' || coalesce(public.merchant_order_display(p_order), '') || ' Received'
      when p_kind = 'shop' then 'Payment ' || coalesce(public.merchant_order_display(p_order), '') || ' Received'
      when coalesce(p_personal, true) then 'Request ' || coalesce(public.merchant_order_display(p_order), '') || ' Amount Received'
      else 'Requested ' || coalesce(public.merchant_order_display(p_order), '') || ' Payment Received'
    end
$$;

create or replace function public.merchant_order_meta(p_order text, p_intent uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'merchantPayment', true,
    'merchantOrder', p_order,
    'merchantName', i.merchant_name,
    'merchantOrderKind', i.kind,
    'merchantPersonal', coalesce(i.personal, false),
    'merchantVia', i.via
  )
  from public.merchant_payment_intents i where i.id = p_intent
$$;
revoke execute on function public.merchant_order_meta(text, uuid) from public, anon, authenticated;
grant execute on function public.merchant_order_meta(text, uuid) to service_role;

create or replace function public.merchant_payment_intents_notify()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare
  who text;
  payer_id text;
  shop text := coalesce(nullif(new.merchant_name, ''), 'the merchant');
  amt text := '$' || trim(to_char(new.received_amount, 'FM999999990.00')) || ' USDC';
  onchain text := case when new.source_chain is not null and new.source_chain <> 'Arc_Testnet'
                       then ' on ' || public.merchant_chain_label(new.source_chain) else '' end;
  -- A Shop QR order is a plain payment ("Payment #108"), not a request.
  k text := case when new.via = 'shop_qr' then 'shop' else new.kind end;
  paid_title text := public.merchant_order_title(k, new.personal, new.order_number, true);
  open_title text := public.merchant_order_title(k, new.personal, new.order_number, false);
  received_title text := public.merchant_order_received_title(k, new.personal, new.order_number);
  last public.merchant_payments;
begin
  -- Who actually paid: the latest payment on the order (anyone can pay a
  -- bill), else the order's customer.
  select * into last from public.merchant_payments p where p.intent_id = new.id order by p.created_at desc, p.id desc limit 1;
  who := coalesce(nullif(last.customer_username, ''),
                  case when last.from_address is not null then substr(last.from_address, 1, 6) || '…' || right(last.from_address, 4) end,
                  nullif(new.customer_username, ''),
                  case when new.customer_wallet is not null then substr(new.customer_wallet, 1, 6) || '…' || right(new.customer_wallet, 4) end,
                  'A customer');
  payer_id := case when last.id is not null then last.customer_user_id else new.customer_user_id end;

  if new.status = 'paid' and old.status is distinct from 'paid' and old.status is distinct from 'processing'
     and not coalesce(new.completed_by_merchant, false) then
    if new.merchant_user_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.merchant_user_id, 'merchant_payment_received',
              case when onchain <> '' then 'Payment received on ' || public.merchant_chain_label(new.source_chain) else received_title end,
              amt || ' from ' || who
                || case when onchain <> '' then ' · ' || received_title
                        else coalesce(' · ' || nullif(new.note, ''), '') end, false);
    end if;
    if payer_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (payer_id, 'merchant_order_paid', paid_title,
              'You paid ' || amt || ' to ' || shop || onchain, false);
    end if;
  end if;

  if new.status = 'partially_paid' and new.received_amount is distinct from old.received_amount then
    if new.merchant_user_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.merchant_user_id, 'merchant_payment_partial', 'Partial payment · ' || open_title,
              who || ' paid ' || amt || ' of $' || trim(to_char(new.requested_amount, 'FM999999990.00')) || ' USDC' || onchain, false);
    end if;
    if payer_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (payer_id, 'merchant_payment_partial', 'Partial payment · ' || open_title,
              'You paid ' || amt || ' of $' || trim(to_char(new.requested_amount, 'FM999999990.00')) || ' USDC to ' || shop || onchain, false);
    end if;
  end if;

  if new.status = 'paid' and old.status is distinct from 'paid' and coalesce(new.completed_by_merchant, false)
     and new.customer_user_id is not null then
    insert into public.notifications (user_id, type, title, message, read)
    values (new.customer_user_id, 'merchant_order_completed', 'Completed · ' || open_title,
            shop || ' marked ' || open_title || ' as completed', false);
  end if;
  return new;
end;
$function$;
revoke all on function public.merchant_payment_intents_notify() from public, anon, authenticated;

-- Shop QR payments already in Activity (both sides).
update public.activity a
   set metadata = a.metadata || jsonb_build_object('merchantVia', 'shop_qr')
 where a.metadata ? 'merchantOrder'
   and a.metadata->>'merchantVia' is null
   and a.metadata->>'merchantOrder' in (select order_number from public.merchant_payment_intents where via = 'shop_qr' and order_number is not null);
