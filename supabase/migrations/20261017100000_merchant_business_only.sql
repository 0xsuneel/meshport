-- Merchant applications are for business accounts only.
--
-- A business account is chosen at sign-up. start_business_account() marks
-- the caller's own account as business, but only while it is new (created in
-- the last 30 minutes) and has never applied - so an existing personal
-- account can't turn itself into a business later. The sign-up screen calls
-- it right before sending the merchant application; name-register also sets
-- the type when the user signs their on-chain name.

create or replace function public.start_business_account()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare uid uuid := auth.uid(); t text;
begin
  if uid is null then return false; end if;
  update public.users set account_type = 'business'
   where auth_uid = uid
     and account_type = 'personal'
     and created_at > now() - interval '30 minutes'
     and not exists (select 1 from public.merchant_applications m where m.auth_uid = uid);
  select account_type into t from public.users where auth_uid = uid limit 1;
  return t = 'business';
end $$;

revoke all on function public.start_business_account() from public, anon;
grant execute on function public.start_business_account() to authenticated;

-- Runs after merchant_applications_before_write (alphabetical), which has
-- already checked that the session has a MeshPort account.
create or replace function public.merchant_applications_business_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.users where auth_uid = new.auth_uid and account_type = 'business') then
    raise exception 'Merchant applications are for business accounts. Create a business account at sign-up.'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists merchant_applications_business_only on public.merchant_applications;
create trigger merchant_applications_business_only
  before insert on public.merchant_applications
  for each row execute function public.merchant_applications_business_only();
