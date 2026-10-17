-- The shop a business applied with (merchant_applications.business_name) is
-- its main store: approval creates it, so it shows in the store switcher,
-- gets its own QR and its own totals. Other outlets are added later.
create or replace function public.merchant_application_main_store()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved')
     and nullif(trim(coalesce(new.business_name, '')), '') is not null
     and not exists (select 1 from public.business_stores s
                      where s.owner_auth_uid = new.auth_uid and lower(s.name) = lower(trim(new.business_name))) then
    insert into public.business_stores (owner_auth_uid, name, type, is_default)
    values (new.auth_uid, left(trim(new.business_name), 60), new.business_type,
            not exists (select 1 from public.business_stores s where s.owner_auth_uid = new.auth_uid and s.is_default));
  end if;
  return new;
end $$;

create trigger merchant_application_main_store after insert or update of status on public.merchant_applications
  for each row execute function public.merchant_application_main_store();

-- Businesses approved before this: add their main store and make it the default.
do $$
declare a record; sid uuid;
begin
  for a in select distinct on (auth_uid) auth_uid, business_name, business_type from public.merchant_applications
           where status = 'approved' and nullif(trim(coalesce(business_name, '')), '') is not null
           order by auth_uid, created_at desc loop
    select id into sid from public.business_stores where owner_auth_uid = a.auth_uid and lower(name) = lower(trim(a.business_name));
    if sid is null then
      update public.business_stores set is_default = false where owner_auth_uid = a.auth_uid and is_default;
      insert into public.business_stores (owner_auth_uid, name, type, is_default)
      values (a.auth_uid, left(trim(a.business_name), 60), a.business_type, true);
    end if;
  end loop;
end $$;
