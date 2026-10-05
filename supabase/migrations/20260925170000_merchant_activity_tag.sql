-- A merchant's order payment on Arc arrives as an ordinary "receive" in
-- Activity (the Arc deposit pipeline records it the moment it lands). Tag
-- that activity row with the order so the app shows it as
-- "Payment received · Order #…" instead of a plain "Received from".
-- Works in both orders of arrival: payment linked first (tag on activity
-- insert) or activity first (tag when the payment is recorded).

create or replace function public.merchant_payments_tag_activity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.activity a
     set metadata = coalesce(a.metadata, '{}'::jsonb)
                    || jsonb_build_object('merchantPayment', true, 'merchantOrder', new.order_number)
   where a.activity_type = 'receive'
     and lower(a.wallet_address) = lower(new.merchant_wallet)
     and lower(regexp_replace(a.tx_hash, '^recv_', '')) = lower(new.tx_hash)
     and coalesce(a.metadata->>'merchantOrder', '') is distinct from coalesce(new.order_number, '');
  return new;
end;
$$;
drop trigger if exists merchant_payments_tag_activity on public.merchant_payments;
create trigger merchant_payments_tag_activity
  after insert or update of order_number on public.merchant_payments
  for each row execute function public.merchant_payments_tag_activity();

create or replace function public.activity_tag_merchant_payment()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare o text;
begin
  if new.activity_type = 'receive' and new.tx_hash is not null then
    select p.order_number into o
      from public.merchant_payments p
     where p.tx_hash = lower(regexp_replace(new.tx_hash, '^recv_', ''))
       and p.merchant_wallet = lower(new.wallet_address)
     limit 1;
    if found then
      new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object('merchantPayment', true, 'merchantOrder', o);
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists activity_tag_merchant_payment on public.activity;
create trigger activity_tag_merchant_payment
  before insert on public.activity
  for each row execute function public.activity_tag_merchant_payment();

-- Tag the payments already recorded.
update public.activity a
   set metadata = coalesce(a.metadata, '{}'::jsonb) || jsonb_build_object('merchantPayment', true, 'merchantOrder', p.order_number)
  from public.merchant_payments p
 where a.activity_type = 'receive'
   and lower(a.wallet_address) = lower(p.merchant_wallet)
   and lower(regexp_replace(a.tx_hash, '^recv_', '')) = p.tx_hash;
