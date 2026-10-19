-- Re-enable: approval creates the business's first store from the name it
-- applied with (merchant_applications.business_name), so a freshly approved
-- business always has at least one branch - it shows in the store switcher,
-- gets its own QR and its own totals, instead of starting with zero stores.
--
-- This reverses 20261017206000_no_auto_store_on_approval.sql (which had made
-- the trigger a no-op). The trigger itself still exists from
-- 20261017204000_approved_shop_is_store.sql; we only restore the function body.
--
-- Safer than the original backfill in one way: for a business that already
-- has stores, the brand store is added as a NON-default branch (the existing
-- default/main store is left alone), so untagged orders are not re-routed.
create or replace function public.merchant_application_main_store()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved')
     and nullif(trim(coalesce(new.business_name, '')), '') is not null
     and not exists (select 1 from public.business_stores s
                      where s.owner_auth_uid = new.auth_uid and lower(s.name) = lower(trim(new.business_name))) then
    insert into public.business_stores (owner_auth_uid, name, type, is_default)
    values (new.auth_uid, trim(left(trim(new.business_name), 60)), new.business_type,
            not exists (select 1 from public.business_stores s where s.owner_auth_uid = new.auth_uid and s.is_default));
  end if;
  return new;
end $$;

-- Backfill approved businesses: add the brand store if they don't already
-- have one by that name. Make it the default only when they have no default
-- yet (so a store they already marked as main is never demoted).
do $$
declare a record;
begin
  for a in select distinct on (auth_uid) auth_uid, business_name, business_type
             from public.merchant_applications
            where status = 'approved' and nullif(trim(coalesce(business_name, '')), '') is not null
            order by auth_uid, created_at desc loop
    if not exists (select 1 from public.business_stores s
                    where s.owner_auth_uid = a.auth_uid and lower(s.name) = lower(trim(a.business_name))) then
      insert into public.business_stores (owner_auth_uid, name, type, is_default)
      values (a.auth_uid, trim(left(trim(a.business_name), 60)), a.business_type,
              not exists (select 1 from public.business_stores s where s.owner_auth_uid = a.auth_uid and s.is_default));
    end if;
  end loop;
end $$;
