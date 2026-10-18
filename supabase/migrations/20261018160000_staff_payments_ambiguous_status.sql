-- staff_payments failed for every caller with "column reference "status" is
-- ambiguous": the function returns a `status` column, so the unqualified
-- `status` in the staff lookup clashed with that output parameter (plpgsql
-- raises 42702). Staff mode showed "No payments yet" for every cashier and
-- manager. Same function, with the staff row's columns qualified.
create or replace function public.staff_payments(p_owner uuid, p_limit integer default 100)
returns table(id uuid, intent_id uuid, source_chain text, tx_hash text, from_address text, amount numeric, status text,
              customer_username text, order_number text, created_at timestamp with time zone, store_id uuid,
              late boolean, screen_flag text)
language plpgsql
stable security definer
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
       and (st.store_id is null or i.store_id = st.store_id)
       and (st.role = 'manager' or p.created_at >= date_trunc('day', now()))
     order by p.created_at desc limit least(greatest(p_limit, 1), 500);
end $function$;

revoke all on function public.staff_payments(uuid, integer) from public, anon;
grant execute on function public.staff_payments(uuid, integer) to authenticated, service_role;
