-- A business with one store has no store name for customers (28 Nov, like
-- Paytm: stores only matter with several outlets). Its only store's public
-- name is the business's display name, so no screen shows a second name
-- (every screen leaves out a store line that repeats the business's name).
-- The owner's own label for it (business_stores.name) stays, for their
-- screens. With two or more stores, each keeps its own reviewed name.

create or replace function public.business_single_store_name()
returns trigger language plpgsql security definer set search_path to '' as $function$
declare dn text;
begin
  if exists (select 1 from public.business_stores o where o.owner_auth_uid = new.owner_auth_uid and o.id <> new.id) then
    return new;
  end if;
  select nullif(trim(coalesce(u.store_name, '')), '') into dn from public.users u
   where u.auth_uid = new.owner_auth_uid and u.account_type = 'business' limit 1;
  if dn is not null then
    new.public_name := dn; new.name_review_since := null;
  end if;
  return new;
end $function$;
-- Runs after business_stores_name_review (triggers fire by name).
drop trigger if exists business_stores_single_store_name on public.business_stores;
create trigger business_stores_single_store_name before insert or update on public.business_stores
  for each row execute function public.business_single_store_name();

-- The display name changed, or a store was removed leaving one: that store follows.
create or replace function public.business_single_store_resync(p_owner uuid)
returns void language sql security definer set search_path to '' as $function$
  update public.business_stores s set public_name = s.public_name
   where s.owner_auth_uid = p_owner
     and (select count(*) from public.business_stores o where o.owner_auth_uid = p_owner) = 1
$function$;
revoke execute on function public.business_single_store_resync(uuid) from anon, authenticated, public;

create or replace function public.users_display_name_to_store()
returns trigger language plpgsql security definer set search_path to '' as $function$
begin
  if new.auth_uid is not null and new.store_name is distinct from old.store_name then
    perform public.business_single_store_resync(new.auth_uid);
  end if;
  return new;
end $function$;
drop trigger if exists users_display_name_to_store on public.users;
create trigger users_display_name_to_store after update of store_name on public.users
  for each row execute function public.users_display_name_to_store();

create or replace function public.business_stores_after_delete()
returns trigger language plpgsql security definer set search_path to '' as $function$
begin
  perform public.business_single_store_resync(old.owner_auth_uid);
  return old;
end $function$;
drop trigger if exists business_stores_resync_after_delete on public.business_stores;
create trigger business_stores_resync_after_delete after delete on public.business_stores
  for each row execute function public.business_stores_after_delete();

-- Today's one-store businesses.
update public.business_stores s set public_name = s.public_name
 where (select count(*) from public.business_stores o where o.owner_auth_uid = s.owner_auth_uid) = 1;
