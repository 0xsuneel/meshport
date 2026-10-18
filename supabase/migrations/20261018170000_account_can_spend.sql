-- Business accounts can't spend until MeshPort approves them.
--
-- account_can_spend(auth uid): true unless the account is a business
-- (users.account_type = 'business') with no APPROVED merchant application.
-- Personal accounts (staff included), admins and approved businesses: true.
-- Unknown/NULL uid: true (callers authenticate separately; service-role
-- paths have no uid).
--
-- wallet_can_spend(wallet): the same rule for the account that owns a wallet
-- (servers that only know the wallet - e.g. the transaction_intents guard).

create or replace function public.account_can_spend(p_auth_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
    from public.users u
    where p_auth_uid is not null
      and u.auth_uid = p_auth_uid
      and u.account_type = 'business'
      and not exists (
        select 1 from public.merchant_applications m
        where m.status = 'approved'
          and (m.auth_uid = p_auth_uid or m.user_id = u.id::text)
      )
  )
$$;

create or replace function public.wallet_can_spend(p_wallet text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
    from public.users u
    where coalesce(p_wallet, '') <> ''
      and coalesce(u.wallet_address, '') <> ''
      and lower(u.wallet_address) = lower(p_wallet)
      and u.account_type = 'business'
      and not exists (
        select 1 from public.merchant_applications m
        where m.status = 'approved'
          and ((u.auth_uid is not null and m.auth_uid = u.auth_uid) or m.user_id = u.id::text)
      )
  )
$$;

revoke all on function public.account_can_spend(uuid) from public, anon;
revoke all on function public.wallet_can_spend(text) from public, anon;
grant execute on function public.account_can_spend(uuid) to authenticated, service_role;
grant execute on function public.wallet_can_spend(text) to service_role;
