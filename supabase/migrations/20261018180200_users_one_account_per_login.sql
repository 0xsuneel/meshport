-- One MeshPort account per Google / email login.
--
-- A wallet already can't have two accounts (users_wallet_address_unique).
-- This refuses a new users row from an app session that is a real (not
-- guest) sign-in and is already linked to another account. Guest sessions
-- are per device and not an identity - their accounts are identified by the
-- wallet instead. SECURITY DEFINER: users.auth_uid isn't readable by clients.
create or replace function public.users_one_account_per_login()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  claims jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
  uid uuid := auth.uid();
begin
  if coalesce(claims ->> 'role', '') not in ('anon', 'authenticated') or uid is null then
    return new;
  end if;
  if coalesce((claims ->> 'is_anonymous')::boolean, false) then
    return new;
  end if;
  if exists (select 1 from public.users u where u.auth_uid = uid and u.id <> new.id) then
    raise exception 'This login already has a MeshPort account' using errcode = '23505';
  end if;
  return new;
end
$$;

revoke all on function public.users_one_account_per_login() from public, anon, authenticated;

create or replace trigger users_one_account_per_login
  before insert on public.users
  for each row execute function public.users_one_account_per_login();
