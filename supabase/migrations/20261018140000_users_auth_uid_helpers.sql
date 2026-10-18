-- Helpers so access rules can find "my account" without reading
-- users.auth_uid under the caller's own privileges. Each one only ever
-- answers about the calling session, so it reveals nothing about others.

-- Every account bound to this session (normally exactly one).
create or replace function public.my_user_ids()
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(u.id), '{}'::uuid[])
    from public.users u
   where auth.uid() is not null and u.auth_uid = auth.uid()
$$;

-- The account bound to this session (oldest if several), or null.
create or replace function public.my_user_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select u.id from public.users u
   where auth.uid() is not null and u.auth_uid = auth.uid()
   order by u.created_at
   limit 1
$$;

-- Same rule the older policies used: the account (by its id as text) is
-- bound to this session, or not bound to any session yet.
create or replace function public.session_may_use_user(p_user_id text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case
    when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      exists (select 1 from public.users u
               where u.id = p_user_id::uuid
                 and (u.auth_uid = auth.uid() or u.auth_uid is null))
    else false end
$$;

-- Same rule by wallet address.
create or replace function public.session_may_use_wallet(p_wallet text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.users u
                  where (u.auth_uid = auth.uid() or u.auth_uid is null)
                    and lower(u.wallet_address) = lower(p_wallet))
$$;

-- Lowercased wallets of this session's business account(s).
create or replace function public.my_business_wallets()
returns text[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(lower(u.wallet_address)), '{}'::text[])
    from public.users u
   where auth.uid() is not null and u.auth_uid = auth.uid()
     and u.account_type = 'business' and u.wallet_address is not null
$$;

revoke all on function public.my_user_ids() from public;
revoke all on function public.my_user_id() from public;
revoke all on function public.session_may_use_user(text) from public;
revoke all on function public.session_may_use_wallet(text) from public;
revoke all on function public.my_business_wallets() from public;
-- anon too: policies for role "public" call these for anon requests.
grant execute on function public.my_user_ids() to anon, authenticated, service_role;
grant execute on function public.my_user_id() to anon, authenticated, service_role;
grant execute on function public.session_may_use_user(text) to anon, authenticated, service_role;
grant execute on function public.session_may_use_wallet(text) to anon, authenticated, service_role;
grant execute on function public.my_business_wallets() to anon, authenticated, service_role;
