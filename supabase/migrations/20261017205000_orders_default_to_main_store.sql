-- Every order belongs to a store: one made without a store goes to the
-- business's main (default) store, and older untagged orders are tagged.
create or replace function public.merchant_intents_store_check()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if tg_op = 'INSERT' and new.store_id is null then
    select s.id into new.store_id from public.business_stores s
     where s.owner_auth_uid = new.merchant_auth_uid and s.is_default limit 1;
  end if;
  if new.store_id is not null and not exists (
    select 1 from public.business_stores s where s.id = new.store_id and s.owner_auth_uid = new.merchant_auth_uid
  ) then
    raise exception 'Unknown store';
  end if;
  return new;
end $function$;

update public.merchant_payment_intents i set store_id = s.id
  from public.business_stores s
 where i.store_id is null and s.owner_auth_uid = i.merchant_auth_uid and s.is_default;
