-- Per-store logos (Square: each location has its own logo and branding).
-- Like store names (20261126210000), a logo is checked before customers see
-- it - a branch could otherwise show another brand's logo next to a verified
-- badge:
--   logo_url          the owner's upload - shown in their own screens at once
--   public_logo_url   what customers see (Shop QR page, receipts); set by
--                     MeshPort's review. Until then: the business's own photo.
--   logo_review_since set while a new logo waits for review
-- Only images in MeshPort's own storage (attachments/store-logos/) are
-- accepted - never an outside link.

alter table public.business_stores
  add column if not exists logo_url text,
  add column if not exists public_logo_url text,
  add column if not exists logo_review_since timestamptz;

create or replace function public.business_stores_name_review()
returns trigger language plpgsql set search_path to '' as $function$
begin
  if current_user in ('anon', 'authenticated') then
    -- The app can't set what customers see.
    if tg_op = 'INSERT' then
      new.public_name := null; new.name_review_since := null;
      new.public_logo_url := null; new.logo_review_since := null;
    else
      new.public_name := old.public_name; new.name_review_since := old.name_review_since;
      new.public_logo_url := old.public_logo_url; new.logo_review_since := old.logo_review_since;
    end if;
  end if;
  if tg_op = 'INSERT' or new.name is distinct from old.name then
    if lower(trim(new.name)) = lower(trim(coalesce(new.public_name, '')))
       or public.store_name_auto_public(new.owner_auth_uid, new.name) then
      new.public_name := new.name; new.name_review_since := null;
    else
      new.name_review_since := now();
    end if;
  end if;
  -- Logo: MeshPort's storage only; a new one waits for review, removing it is immediate.
  new.logo_url := nullif(trim(coalesce(new.logo_url, '')), '');
  if new.logo_url is not null
     and new.logo_url !~ '^https://cvvpzfvzweszuuxvaayb\.supabase\.co/storage/v1/object/public/attachments/store-logos/[A-Za-z0-9_.-]+(\?t=[0-9]+)?$' then
    raise exception 'Upload the logo from the app' using errcode = '22023';
  end if;
  if tg_op = 'INSERT' or new.logo_url is distinct from old.logo_url then
    if new.logo_url is null then
      new.public_logo_url := null; new.logo_review_since := null;
    elsif new.logo_url is distinct from new.public_logo_url then
      new.logo_review_since := now();
    end if;
  end if;
  return new;
end $function$;

-- Admin review --------------------------------------------------------------
create or replace function public.admin_store_logo_changes()
returns table(store_id uuid, username text, business_name text, store_name text, current_logo text, pending_logo text, pending_since timestamptz)
language plpgsql stable security definer set search_path to '' as $function$
begin
  if not exists (select 1 from public.admin_users a where a.id = auth.uid()) then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  return query
    select s.id, u.username::text,
           coalesce(nullif(u.store_name, ''), (select m.business_name from public.merchant_applications m
             where m.auth_uid = s.owner_auth_uid and m.status = 'approved' order by m.created_at desc limit 1))::text,
           coalesce(s.public_name, s.name)::text, s.public_logo_url::text, s.logo_url::text, s.logo_review_since
      from public.business_stores s
      left join public.users u on u.auth_uid = s.owner_auth_uid
     where s.logo_review_since is not null and s.logo_url is not null
     order by s.logo_review_since;
end $function$;
revoke execute on function public.admin_store_logo_changes() from anon, public;
grant execute on function public.admin_store_logo_changes() to authenticated;

create or replace function public.admin_review_store_logo(p_store uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path to '' as $function$
declare s record; uid text;
begin
  if not exists (select 1 from public.admin_users a where a.id = auth.uid()) then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  select id, name, logo_url, owner_auth_uid, logo_review_since into s from public.business_stores where id = p_store for update;
  if s.logo_review_since is null or s.logo_url is null then raise exception 'No store logo waiting'; end if;
  select u.id::text into uid from public.users u where u.auth_uid = s.owner_auth_uid limit 1;
  if p_approve then
    update public.business_stores set public_logo_url = s.logo_url, logo_review_since = null where id = p_store;
    if uid is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (uid, 'store_logo_approved', 'Store logo approved', 'Customers now see the new logo for ' || s.name || '.', false);
    end if;
  else
    update public.business_stores set logo_review_since = null where id = p_store;
    if uid is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (uid, 'store_logo_rejected', 'Store logo not approved',
              coalesce(nullif(trim(p_note), ''), 'Customers keep seeing your current logo for ' || s.name || '.'), false);
    end if;
  end if;
end $function$;
revoke execute on function public.admin_review_store_logo(uuid, boolean, text) from anon, public;
grant execute on function public.admin_review_store_logo(uuid, boolean, text) to authenticated;

-- The Shop QR page shows the store's approved logo, else the business's photo.
drop function if exists public.shop_info(text, uuid);
create function public.shop_info(p_username text, p_store uuid default null)
returns table(business_name text, username text, store_id uuid, store_name text, avatar_url text, verified boolean,
              category text, address text, mcc text, contact text)
language plpgsql stable security definer set search_path to '' as $function$
declare u record; a record; s record; cat text;
begin
  select x.id, x.auth_uid, x.username, x.display_name, x.store_name, x.avatar_url, x.account_type, x.shop_contact into u
    from public.users x where lower(x.username) = lower(regexp_replace(trim(coalesce(p_username, '')), '\.arc$', '')) limit 1;
  if u.id is null then return; end if;
  select m.business_name, m.business_type into a from public.merchant_applications m
   where m.auth_uid = u.auth_uid and m.status = 'approved' order by m.created_at desc limit 1;
  if coalesce(u.account_type, 'personal') <> 'business' and a.business_name is null then return; end if;
  select b.id, b.public_name as name, b.address, b.public_logo_url, (b.id = p_store) as asked into s
    from public.business_stores b
   where b.owner_auth_uid = u.auth_uid and ((p_store is not null and b.id = p_store) or b.is_default)
   order by (b.id = p_store) desc nulls last limit 1;
  cat := nullif(trim(coalesce(a.business_type, '')), '');
  return query select coalesce(nullif(u.store_name, ''), nullif(a.business_name, ''), nullif(u.display_name, ''), u.username || '.arc')::text,
                      u.username::text,
                      case when s.asked then s.id end,
                      case when s.asked then s.name::text end,
                      coalesce(case when a.business_name is not null then s.public_logo_url end, u.avatar_url)::text,
                      a.business_name is not null,
                      cat,
                      nullif(trim(coalesce(s.address, '')), '')::text,
                      case when cat is not null then public.business_mcc(cat) end,
                      case when a.business_name is not null then u.shop_contact::text end;
end $function$;
grant execute on function public.shop_info(text, uuid) to anon, authenticated, service_role;

-- Push taps for logo decisions open Business, like store-name decisions.
do $do$
declare d text; a text := $q$'store_name_approved', 'store_name_rejected')$q$;
begin
  d := pg_get_functiondef('public.p2p_dispatch_push_for_notification'::regproc);
  if position(a in d) = 0 then raise exception 'push routing changed - update this migration'; end if;
  if position('store_logo_approved' in d) = 0 then
    execute replace(d, a, $q$'store_name_approved', 'store_name_rejected', 'store_logo_approved', 'store_logo_rejected')$q$);
  end if;
end $do$;
