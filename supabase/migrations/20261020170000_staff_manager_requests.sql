-- Staff roles audit fixes.
--
-- 1. staff_payments: a cashier's "today" was the UTC day (05:30 IST), so the
--    night's payments were missing and late evening still showed yesterday's.
--    It is now the India day, the same as merchant_set_due_date. Orders without
--    a store count for the main store (as on the owner's Business tab), so the
--    main store's staff see them too.
-- 2. staff_intents: a manager's Requests list - the business's requests and
--    bills for the manager's store. Managers only.
-- 3. staff_refunds: the refunds on those orders, for a manager's statement.
--    Managers only.
begin;

create or replace function public.staff_store_match(p_owner uuid, p_staff_store uuid, p_intent_store uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select p_staff_store is null
      or p_intent_store = p_staff_store
      or (p_intent_store is null and p_staff_store = (
            select s.id from public.business_stores s
             where s.owner_auth_uid = p_owner
             order by s.is_default desc, s.created_at limit 1));
$$;
revoke all on function public.staff_store_match(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public.staff_payments(p_owner uuid, p_limit integer default 100)
returns table(id uuid, intent_id uuid, source_chain text, tx_hash text, from_address text, amount numeric, status text,
              customer_username text, order_number text, created_at timestamp with time zone, store_id uuid, late boolean, screen_flag text)
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare st public.business_staff;
begin
  select * into st from public.business_staff b
   where b.owner_auth_uid = p_owner and b.staff_auth_uid = auth.uid() and b.status = 'active';
  if st.id is null then raise exception 'You are not staff of this business'; end if;
  if not exists (select 1 from public.merchant_applications a where a.auth_uid = p_owner and a.status = 'approved') then
    raise exception 'This business is not approved yet';
  end if;
  return query
    select p.id, p.intent_id, p.source_chain, p.tx_hash, p.from_address, p.amount, p.status, p.customer_username, p.order_number, p.created_at, i.store_id,
           p.late, p.screen_flag
      from public.merchant_payments p join public.merchant_payment_intents i on i.id = p.intent_id
     where i.merchant_auth_uid = p_owner
       and public.staff_store_match(p_owner, st.store_id, i.store_id)
       and (st.role = 'manager'
            or p.created_at >= (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'))
     order by p.created_at desc limit least(greatest(p_limit, 1), 500);
end $function$;

create or replace function public.staff_intents(p_owner uuid, p_limit integer default 200)
returns setof public.merchant_payment_intents
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare st public.business_staff;
begin
  select * into st from public.business_staff b
   where b.owner_auth_uid = p_owner and b.staff_auth_uid = auth.uid() and b.status = 'active';
  if st.id is null then raise exception 'You are not staff of this business'; end if;
  if st.role <> 'manager' then raise exception 'Requests are for managers'; end if;
  return query
    select i.* from public.merchant_payment_intents i
     where i.merchant_auth_uid = p_owner
       and coalesce(i.personal, false) = false
       and public.staff_store_match(p_owner, st.store_id, i.store_id)
     order by i.created_at desc limit least(greatest(p_limit, 1), 500);
end $function$;
revoke all on function public.staff_intents(uuid, integer) from public, anon;
grant execute on function public.staff_intents(uuid, integer) to authenticated;

create or replace function public.staff_refunds(p_owner uuid)
returns table(id uuid, payment_id uuid, receipt_id uuid, amount numeric, reason text, tx_hash text, created_at timestamp with time zone, refund_chain text, route text)
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare st public.business_staff;
begin
  select * into st from public.business_staff b
   where b.owner_auth_uid = p_owner and b.staff_auth_uid = auth.uid() and b.status = 'active';
  if st.id is null then raise exception 'You are not staff of this business'; end if;
  if st.role <> 'manager' then raise exception 'Statements are for managers'; end if;
  return query
    select r.id, r.payment_id, r.receipt_id, r.amount, r.reason, r.tx_hash, r.created_at, r.refund_chain, r.route
      from public.merchant_refunds r join public.merchant_payment_intents i on i.id = r.intent_id
     where r.merchant_auth_uid = p_owner
       and public.staff_store_match(p_owner, st.store_id, i.store_id)
     order by r.created_at desc limit 1000;
end $function$;
revoke all on function public.staff_refunds(uuid) from public, anon;
grant execute on function public.staff_refunds(uuid) to authenticated;

commit;
