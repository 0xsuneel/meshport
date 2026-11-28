-- A payment to the business's username (or wallet address) counts for the
-- business, not a store (28 Nov) - a store's sales come only from its own QR.
-- Staff at any store still see one from the last 15 minutes in their live
-- feed, so a cashier can confirm it and hand over the goods; it isn't
-- counted in their store.
create or replace function public.staff_business_payments(p_owner uuid)
returns table (id uuid, source_chain text, tx_hash text, from_address text, amount numeric, customer_username text, created_at timestamptz)
language plpgsql stable security definer set search_path to '' as $function$
begin
  if not exists (select 1 from public.business_staff b
                  where b.owner_auth_uid = p_owner and b.staff_auth_uid = auth.uid() and b.status = 'active') then
    raise exception 'You are not staff of this business';
  end if;
  return query
    select p.id, p.source_chain, p.tx_hash, p.from_address, p.amount, p.customer_username, p.created_at
      from public.merchant_payments p join public.merchant_payment_intents i on i.id = p.intent_id
     where i.merchant_auth_uid = p_owner and i.via = 'shop_qr'
       and i.store_id is null and i.counter_id is null and i.link_id is null
       and p.created_at > now() - interval '15 minutes' and p.screen_flag is null
     order by p.created_at desc limit 20;
end $function$;
revoke execute on function public.staff_business_payments(uuid) from anon, public;
grant execute on function public.staff_business_payments(uuid) to authenticated;
