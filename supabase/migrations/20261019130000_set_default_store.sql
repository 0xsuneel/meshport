-- Let a business choose which store is its main (default) one. The owner
-- decides - a store is made main from Stores & staff, not forced by the app.
--
-- business_stores has a one-default-per-owner unique index, so switching the
-- main store has to clear the old default and set the new one together; a
-- plain client update would collide. This RPC does both in one transaction,
-- for a store the caller actually owns.
create or replace function public.business_set_default_store(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare owner uuid;
begin
  select owner_auth_uid into owner from public.business_stores where id = p_id;
  if owner is null or owner <> auth.uid() then
    raise exception 'Unknown store';
  end if;
  update public.business_stores set is_default = false where owner_auth_uid = owner and is_default and id <> p_id;
  update public.business_stores set is_default = true  where id = p_id and not is_default;
end $$;

revoke all on function public.business_set_default_store(uuid) from anon;
grant execute on function public.business_set_default_store(uuid) to authenticated;
