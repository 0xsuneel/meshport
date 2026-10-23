-- A Shop QR payment isn't an order anyone asked for: it gets no order number
-- (bills and requests keep theirs, and no longer skip numbers taken by Shop
-- QR payments). Existing Shop QR payments keep the numbers they already have.
alter table public.merchant_payment_intents alter column order_number drop not null;

create or replace function public.merchant_intents_order_number()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if tg_op = 'INSERT' then
    -- Same test merchant_payment_intents_before_write uses (it runs after
    -- this trigger): only shop_open_order makes a real Shop QR order.
    new.order_number := case when new.via = 'shop_qr' and coalesce(current_setting('meshport.shop_qr', true), '') = '1' then null
                             else 'ORD-' || nextval('public.merchant_order_seq') end;
  else
    new.order_number := old.order_number;
  end if;
  return new;
end;
$function$;

-- Tagging a payment's Activity rows: it used to skip rows whose order number
-- already matched, so a payment with no number (Shop QR) was never tagged.
-- Now: tag any row not tagged yet, or tagged with a different number.
create or replace function public.merchant_payments_tag_activity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare meta jsonb := public.merchant_order_meta(new.order_number, new.intent_id);
begin
  update public.activity a
     set metadata = coalesce(a.metadata, '{}'::jsonb) || meta
   where lower(regexp_replace(a.tx_hash, '^(recv_|send_)', '')) = lower(new.tx_hash)
     and (
       (a.activity_type = 'receive' and lower(a.wallet_address) = lower(new.merchant_wallet)) or
       (a.activity_type = 'send'    and lower(a.wallet_address) = lower(new.from_address))
     )
     and (a.metadata->>'merchantPayment' is null
          or coalesce(a.metadata->>'merchantOrder', '') is distinct from coalesce(new.order_number, ''));
  return new;
end;
$function$;
