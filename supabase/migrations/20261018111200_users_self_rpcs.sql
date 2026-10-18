-- Your own profile (with your email), and session checks, without reading
-- other people's users.email / users.auth_uid.
create or replace function public.my_profile()
returns table (id uuid, username text, display_name text, email text, wallet_address text, avatar_url text,
               created_at timestamptz, account_type text, store_name text)
language sql stable security definer set search_path = '' as $$
  select u.id, u.username, u.display_name, u.email, u.wallet_address, u.avatar_url, u.created_at, u.account_type, u.store_name
    from public.users u
   where auth.uid() is not null and u.auth_uid = auth.uid()
   order by u.created_at
   limit 1
$$;

create or replace function public.session_owns_user(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
     and exists (select 1 from public.users u where u.id = p_user_id and u.auth_uid = auth.uid())
$$;

-- Another MeshPort account already uses this sign-in's email.
create or replace function public.session_email_conflict()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.users u, auth.users a
     where a.id = auth.uid() and a.email is not null and a.email <> ''
       and lower(u.email) = lower(a.email) and u.auth_uid is distinct from auth.uid())
$$;

revoke execute on function public.my_profile() from public, anon;
revoke execute on function public.session_owns_user(uuid) from public, anon;
revoke execute on function public.session_email_conflict() from public, anon;
grant execute on function public.my_profile() to authenticated;
grant execute on function public.session_owns_user(uuid) to authenticated;
grant execute on function public.session_email_conflict() to authenticated;
