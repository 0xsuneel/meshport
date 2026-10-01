-- Order payments (bills and manual requests, each with a unique order number)
-- never show as a plain receive / paid in Activity — on either side:
--   merchant's "receive" row  → "Payment received · Order #…"
--   customer's "send" row     → "Order payment · Order #…"
-- Ordinary chat payments (no order) are untouched.
-- Tagging happens whichever comes first: the payment being linked to the
-- order (merchant_payments insert) or the Activity row being written.

create or replace function public.merchant_order_meta(p_order text, p_intent uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'merchantPayment', true,
    'merchantOrder', p_order,
    'merchantName', (select merchant_name from public.merchant_payment_intents where id = p_intent),
    'merchantOrderKind', (select kind from public.merchant_payment_intents where id = p_intent)
  )
$$;

create or replace function public.merchant_payments_tag_activity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare meta jsonb := public.merchant_order_meta(new.order_number, new.intent_id);
begin
  update public.activity a
     set metadata = coalesce(a.metadata, '{}'::jsonb) || meta
   where lower(regexp_replace(a.tx_hash, '^(recv_|send_)', '')) = lower(new.tx_hash)
     and (
       (a.activity_type = 'receive' and lower(a.wallet_address) = lower(new.merchant_wallet)) or
       (a.activity_type = 'send'    and lower(a.wallet_address) = lower(new.from_address))
     )
     and coalesce(a.metadata->>'merchantOrder', '') is distinct from coalesce(new.order_number, '');
  return new;
end;
$$;

create or replace function public.activity_tag_merchant_payment()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare p record;
begin
  if new.activity_type in ('receive', 'send') and new.tx_hash is not null then
    select mp.order_number, mp.intent_id into p
      from public.merchant_payments mp
     where mp.tx_hash = lower(regexp_replace(new.tx_hash, '^(recv_|send_)', ''))
       and ((new.activity_type = 'receive' and mp.merchant_wallet = lower(new.wallet_address))
         or (new.activity_type = 'send' and mp.from_address = lower(new.wallet_address)))
     limit 1;
    if found then
      new.metadata := coalesce(new.metadata, '{}'::jsonb) || public.merchant_order_meta(p.order_number, p.intent_id);
    end if;
  end if;
  return new;
end;
$$;

-- Tag everything already recorded (both sides).
update public.activity a
   set metadata = coalesce(a.metadata, '{}'::jsonb) || public.merchant_order_meta(p.order_number, p.intent_id)
  from public.merchant_payments p
 where lower(regexp_replace(a.tx_hash, '^(recv_|send_)', '')) = p.tx_hash
   and ((a.activity_type = 'receive' and lower(a.wallet_address) = p.merchant_wallet)
     or (a.activity_type = 'send' and lower(a.wallet_address) = p.from_address));
