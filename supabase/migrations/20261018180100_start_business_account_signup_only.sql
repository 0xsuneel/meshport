-- start_business_account: the business choice is part of creating the
-- account, not a later switch. Only a just-created account (10 minutes, was
-- 30) whose username hasn't been sent on-chain yet (still 'none' - a personal
-- sign-up registers its name as Personal right after claiming it) and with no
-- merchant application can become a business. It marks the transaction so
-- users_account_type_guard lets this one change through.
create or replace function public.start_business_account()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare uid uuid := auth.uid(); t text;
begin
  if uid is null then return false; end if;
  perform set_config('meshport.business_signup', 'on', true);
  update public.users set account_type = 'business'
   where auth_uid = uid
     and account_type = 'personal'
     and created_at > now() - interval '10 minutes'
     and name_onchain_status = 'none'
     and not exists (select 1 from public.merchant_applications m where m.auth_uid = uid);
  perform set_config('meshport.business_signup', 'off', true);
  select account_type into t from public.users where auth_uid = uid limit 1;
  return t = 'business';
end
$$;
