-- Harden business_set_default_store (added in 20261019130000):
--  1. Null-safe ownership check. `owner <> auth.uid()` evaluates to NULL
--     (not true) when auth.uid() is null - an anonymous caller - so the
--     guard did not fire and the update proceeded for a store the caller
--     does not own. `is distinct from` treats null correctly and rejects.
--  2. Revoke execute from public/anon. CREATE FUNCTION grants execute to
--     PUBLIC by default, which anon inherits, so the function was callable
--     unauthenticated. Only authenticated may call it.
create or replace function public.business_set_default_store(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare owner uuid;
begin
  select owner_auth_uid into owner from public.business_stores where id = p_id;
  if owner is null or owner is distinct from auth.uid() then
    raise exception 'Unknown store';
  end if;
  update public.business_stores set is_default = false where owner_auth_uid = owner and is_default and id <> p_id;
  update public.business_stores set is_default = true  where id = p_id and not is_default;
end $$;

revoke all on function public.business_set_default_store(uuid) from public, anon;
grant execute on function public.business_set_default_store(uuid) to authenticated;
