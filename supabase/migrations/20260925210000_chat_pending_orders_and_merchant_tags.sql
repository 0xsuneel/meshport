-- Chat: pending bills / payment requests between two people (shown on both
-- sides), and which users are approved merchants (the "Merchant" tag in the
-- chat list). Read-only helpers; they expose nothing beyond what the two
-- people in the chat already see on the bill cards.

-- Which of these users are approved merchants.
create or replace function public.merchant_user_flags(p_user_ids uuid[])
returns table (user_id uuid, business_name text)
language sql
stable
security definer
set search_path to 'public'
as $$
  select distinct on (u.id) u.id, ma.business_name
    from public.users u
    join public.merchant_applications ma on ma.auth_uid = u.auth_uid and ma.status = 'approved'
   where u.id = any(p_user_ids)
   order by u.id, ma.created_at desc
$$;

revoke all on function public.merchant_user_flags(uuid[]) from public, anon;
grant execute on function public.merchant_user_flags(uuid[]) to authenticated;

-- Open orders (bills and manual requests) between me and the other person,
-- whichever side is the merchant.
create or replace function public.chat_pending_orders(p_other uuid)
returns table (
  code text, order_number text, kind text, amount numeric, received numeric,
  note text, merchant_name text, i_am_merchant boolean, created_at timestamptz, expires_at timestamptz
)
language sql
stable
security definer
set search_path to 'public'
as $$
  with me as (select id, username from public.users where auth_uid = auth.uid() limit 1),
       other as (select id, username, auth_uid from public.users where id = p_other limit 1)
  select i.code, i.order_number, i.kind, i.requested_amount, i.received_amount,
         i.note, i.merchant_name, (i.merchant_auth_uid = auth.uid()), i.created_at, i.expires_at
    from public.merchant_payment_intents i, me, other
   where i.status in ('pending', 'partially_paid')
     and (i.expires_at is null or i.expires_at > now())
     and (
       -- I'm the merchant, they're the customer
       (i.merchant_auth_uid = auth.uid()
         and (i.customer_user_id = other.id::text or lower(i.customer_username) = lower(other.username)))
       or
       -- They're the merchant, I'm the customer
       (i.merchant_auth_uid = other.auth_uid
         and (i.customer_user_id = me.id::text or lower(i.customer_username) = lower(me.username)))
     )
   order by i.created_at desc
   limit 20
$$;

revoke all on function public.chat_pending_orders(uuid) from public, anon;
grant execute on function public.chat_pending_orders(uuid) to authenticated;
