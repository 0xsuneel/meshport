-- Order numbers for merchant payment requests and bills.
--
-- Every request / bill gets an order number from a database sequence
-- (ORD-100001, ORD-100002, …), so two orders can never share one — it is
-- assigned here on insert and can never be changed afterwards (whatever the
-- client sends is ignored).
--
-- A payment is confirmed against the order: merchant-pay checks the order
-- number and amount the customer paid for, and stores the order number on
-- the payment row.

create sequence if not exists public.merchant_order_seq start with 100001;

alter table public.merchant_payment_intents add column if not exists order_number text;

-- Existing requests get numbers too (oldest first).
do $$
declare r record;
begin
  for r in select id from public.merchant_payment_intents where order_number is null order by created_at loop
    update public.merchant_payment_intents
       set order_number = 'ORD-' || nextval('public.merchant_order_seq')
     where id = r.id;
  end loop;
end $$;

alter table public.merchant_payment_intents alter column order_number set not null;
create unique index if not exists merchant_payment_intents_order_number_key
  on public.merchant_payment_intents (order_number);

create or replace function public.merchant_intents_order_number()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'INSERT' then
    new.order_number := 'ORD-' || nextval('public.merchant_order_seq');
  else
    new.order_number := old.order_number;
  end if;
  return new;
end;
$$;

drop trigger if exists merchant_intents_order_number on public.merchant_payment_intents;
create trigger merchant_intents_order_number
  before insert or update on public.merchant_payment_intents
  for each row execute function public.merchant_intents_order_number();

-- The order a payment was confirmed against.
alter table public.merchant_payments add column if not exists order_number text;
update public.merchant_payments p
   set order_number = i.order_number
  from public.merchant_payment_intents i
 where p.intent_id = i.id and p.order_number is null;
