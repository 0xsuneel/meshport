-- Store (branch) names are reviewed before customers see them, like the
-- business name (20261126190000). Square's model: a location has the
-- owner's own nickname and a public business name customers see.
--
--   name         the owner's label - free to edit, used in their own and
--                their staff's screens.
--   public_name  what customers see (pay page, receipts, printed QR, request
--                sender). Set only by MeshPort's review, or straight away
--                when the name matches the business's approved name.
--   name_review_since  set while a name waits for review.
--
-- Until a branch name is approved, customers see just the business name.
-- Existing stores keep the names customers already see.

alter table public.business_stores
  add column if not exists public_name text,
  add column if not exists name_review_since timestamptz;
update public.business_stores set public_name = name where public_name is null;

-- Whether a store name needs no review: it matches the business's approved
-- name or its (reviewed) business name. Reads users / applications, so it
-- runs as the owner of the function.
create or replace function public.store_name_auto_public(p_owner uuid, p_name text)
returns boolean language sql stable security definer set search_path to '' as $function$
  select lower(trim(coalesce(p_name, ''))) <> '' and (
    exists (select 1 from public.merchant_applications m where m.auth_uid = p_owner and m.status = 'approved'
             and lower(trim(m.business_name)) = lower(trim(p_name)))
    or exists (select 1 from public.users u where u.auth_uid = p_owner and lower(trim(coalesce(u.store_name, ''))) = lower(trim(p_name))))
$function$;
revoke execute on function public.store_name_auto_public(uuid, text) from anon, public;
grant execute on function public.store_name_auto_public(uuid, text) to authenticated;

-- Runs as the caller (not security definer) so it can tell the app's writes
-- (anon / authenticated) from MeshPort's own functions.
create or replace function public.business_stores_name_review()
returns trigger language plpgsql set search_path to '' as $function$
begin
  if current_user in ('anon', 'authenticated') then
    -- The app can't set what customers see.
    if tg_op = 'INSERT' then new.public_name := null; new.name_review_since := null;
    else new.public_name := old.public_name; new.name_review_since := old.name_review_since; end if;
  end if;
  if tg_op = 'INSERT' or new.name is distinct from old.name then
    if lower(trim(new.name)) = lower(trim(coalesce(new.public_name, '')))
       or public.store_name_auto_public(new.owner_auth_uid, new.name) then
      new.public_name := new.name; new.name_review_since := null;
    else
      new.name_review_since := now();
    end if;
  end if;
  return new;
end $function$;
drop trigger if exists business_stores_name_review on public.business_stores;
create trigger business_stores_name_review before insert or update on public.business_stores
  for each row execute function public.business_stores_name_review();

-- Customer-facing reads use public_name ----------------------------------
create or replace function public.merchant_order_meta(p_order text, p_intent uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'merchantPayment', true,
    'merchantOrder', p_order,
    'merchantName', i.merchant_name,
    'merchantOrderKind', i.kind,
    'merchantPersonal', coalesce(i.personal, false),
    'merchantVia', i.via,
    'merchantStore', st.public_name,
    'merchantStoreLabel', st.name,
    'merchantStoreId', i.store_id
  ) - case when i.store_id is null then 'merchantStoreId' else '' end
  from public.merchant_payment_intents i
  left join lateral (
    select s.name, s.public_name from public.business_stores s
     where s.id = i.store_id
        or (i.store_id is null and s.owner_auth_uid = i.merchant_auth_uid and s.is_default)
     order by (s.id = i.store_id) desc limit 1) st on true
  where i.id = p_intent
$$;
revoke execute on function public.merchant_order_meta(text, uuid) from public, anon, authenticated;
grant execute on function public.merchant_order_meta(text, uuid) to service_role;

do $do$
declare d text;
begin
  d := pg_get_functiondef('public.shop_info(text, uuid)'::regprocedure);
  if position('select b.id, b.name into s' in d) = 0 then raise exception 'shop_info changed - update this migration'; end if;
  execute replace(d, 'select b.id, b.name into s', 'select b.id, b.public_name as name into s');

  d := pg_get_functiondef('public.my_due_requests()'::regprocedure);
  if position('nullif(st.name, '''')' in d) = 0 then raise exception 'my_due_requests changed - update this migration'; end if;
  execute replace(d, 'nullif(st.name, '''')', 'nullif(st.public_name, '''')');
end $do$;

-- Staff mode prints the store's QR: give it the public name too.
drop function if exists public.business_staff_memberships();
create function public.business_staff_memberships()
returns table(id uuid, owner_auth_uid uuid, owner_name text, owner_username text, role text, status text, store_id uuid, store_name text, store_public_name text)
language sql stable security definer set search_path to '' as $function$
  select b.id, b.owner_auth_uid,
         coalesce(nullif(u.store_name, ''), (select m.business_name from public.merchant_applications m where m.auth_uid = b.owner_auth_uid and m.status = 'approved' order by m.created_at desc limit 1), u.username),
         u.username, b.role, b.status, b.store_id, s.name, s.public_name
    from public.business_staff b
    join public.users u on u.auth_uid = b.owner_auth_uid
    left join public.business_stores s on s.id = b.store_id
   where b.staff_auth_uid = auth.uid()
$function$;
revoke execute on function public.business_staff_memberships() from anon, public;
grant execute on function public.business_staff_memberships() to authenticated;

-- Admin review ------------------------------------------------------------
create or replace function public.admin_store_name_changes()
returns table(store_id uuid, username text, business_name text, current_public text, pending_name text, pending_since timestamptz)
language plpgsql stable security definer set search_path to '' as $function$
begin
  if not exists (select 1 from public.admin_users a where a.id = auth.uid()) then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  return query
    select s.id, u.username::text,
           coalesce(nullif(u.store_name, ''), (select m.business_name from public.merchant_applications m
             where m.auth_uid = s.owner_auth_uid and m.status = 'approved' order by m.created_at desc limit 1))::text,
           s.public_name::text, s.name::text, s.name_review_since
      from public.business_stores s
      left join public.users u on u.auth_uid = s.owner_auth_uid
     where s.name_review_since is not null
     order by s.name_review_since;
end $function$;
revoke execute on function public.admin_store_name_changes() from anon, public;
grant execute on function public.admin_store_name_changes() to authenticated;

create or replace function public.admin_review_store_name(p_store uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path to '' as $function$
declare s record; uid text;
begin
  if not exists (select 1 from public.admin_users a where a.id = auth.uid()) then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  select id, name, owner_auth_uid, name_review_since into s from public.business_stores where id = p_store for update;
  if s.name_review_since is null then raise exception 'No store name waiting'; end if;
  select u.id::text into uid from public.users u where u.auth_uid = s.owner_auth_uid limit 1;
  if p_approve then
    update public.business_stores set public_name = s.name, name_review_since = null where id = p_store;
    if uid is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (uid, 'store_name_approved', 'Store name approved', 'Customers now see ' || s.name || '.', false);
    end if;
  else
    update public.business_stores set name_review_since = null where id = p_store;
    if uid is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (uid, 'store_name_rejected', 'Store name not approved',
              coalesce(nullif(trim(p_note), ''), 'Customers keep seeing your business name for "' || s.name || '".'), false);
    end if;
  end if;
end $function$;
revoke execute on function public.admin_review_store_name(uuid, boolean, text) from anon, public;
grant execute on function public.admin_review_store_name(uuid, boolean, text) to authenticated;
