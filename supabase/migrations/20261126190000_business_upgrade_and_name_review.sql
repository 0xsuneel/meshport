-- Two changes to business accounts, after comparing with how Venmo, Stripe
-- and Square run theirs.
--
-- 1. A personal account can become a business (Venmo: a business profile on
--    top of the personal account, one login). The person applies from their
--    personal account and stays personal while MeshPort reviews it - a
--    business account that isn't approved can't spend (account_can_spend),
--    so switching at apply time would lock their money. Approval turns the
--    same account into a business: same username, wallet, contacts and
--    history. If that business access is later revoked (or the approval is
--    otherwise withdrawn), an upgraded account goes back to personal, so the
--    person's own money is never locked. Accounts opened as business at
--    sign-up keep today's rules.
--
-- 2. An approved business's new name is reviewed before customers see it
--    (Stripe only accepts a public name that matches the verified business;
--    Square allows a location's name to change 3 times). Until then the
--    approved name stays on the pay page, receipts and the verified badge.
--    Clearing the name (back to the approved name) or typing the approved
--    name again needs no review. Businesses not yet approved name themselves
--    freely - their name is reviewed with the application.

alter table public.users
  add column if not exists business_upgraded_at timestamptz,
  add column if not exists store_name_pending text,
  add column if not exists store_name_pending_at timestamptz;
-- Not client-writable: the app reads them through my_business_name() and
-- changes them only through the functions below (no column grants).

-- 1 ── Personal accounts may apply ─────────────────────────────────────────
create or replace function public.merchant_applications_business_only()
returns trigger language plpgsql security definer set search_path to '' as $function$
begin
  if not exists (select 1 from public.users where auth_uid = new.auth_uid
                  and coalesce(username, '') <> '' and coalesce(wallet_address, '') <> '') then
    raise exception 'Finish setting up your account (username and wallet) before applying'
      using errcode = '42501';
  end if;
  return new;
end $function$;

-- Approval upgrades a personal account; losing approval undoes the upgrade.
create or replace function public.merchant_application_account_type()
returns trigger language plpgsql security definer set search_path to '' as $function$
begin
  if coalesce(current_setting('meshport.merchant_relink', true), '') = 'on' then return new; end if;
  if new.status is not distinct from old.status then return new; end if;
  perform set_config('meshport.business_signup', 'on', true);
  if new.status = 'approved' then
    update public.users
       set account_type = 'business', business_upgraded_at = now(),
           store_name = coalesce(nullif(store_name, ''), left(trim(new.business_name), 60))
     where auth_uid = new.auth_uid and account_type = 'personal';
  elsif old.status = 'approved' then
    -- Only when no other approved application remains for this login.
    if not exists (select 1 from public.merchant_applications m
                    where m.auth_uid = new.auth_uid and m.status = 'approved' and m.id <> new.id) then
      update public.users
         set account_type = 'personal', business_upgraded_at = null,
             store_name = null, store_name_pending = null, store_name_pending_at = null
       where auth_uid = new.auth_uid and account_type = 'business' and business_upgraded_at is not null;
    end if;
  end if;
  perform set_config('meshport.business_signup', 'off', true);
  return new;
end $function$;
revoke execute on function public.merchant_application_account_type() from anon, authenticated, public;
drop trigger if exists merchant_application_account_type on public.merchant_applications;
create trigger merchant_application_account_type
  after update of status on public.merchant_applications
  for each row execute function public.merchant_application_account_type();

-- The guard lets a business go back to personal only through that trigger.
create or replace function public.users_account_type_guard()
returns trigger language plpgsql set search_path to '' as $function$
declare
  jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
begin
  if new.account_type is not distinct from old.account_type then
    return new;
  end if;
  if jwt_role not in ('anon', 'authenticated') and current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if current_setting('meshport.business_signup', true) = 'on'
     and ((old.account_type = 'personal' and new.account_type = 'business')
       or (old.account_type = 'business' and new.account_type = 'personal' and old.business_upgraded_at is not null)) then
    return new;
  end if;
  raise exception 'An account''s type can''t be changed (this is a % account)', old.account_type
    using errcode = '42501';
end
$function$;

-- 2 ── Name changes are reviewed once approved ────────────────────────────
create or replace function public.set_business_name(p_name text)
returns text language plpgsql security definer set search_path = '' as $function$
declare
  n text := nullif(left(regexp_replace(regexp_replace(trim(coalesce(p_name, '')),
    '[\u0001-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]', '', 'g'), '\s+', ' ', 'g'), 60), '');
  u record; approved text;
begin
  if n is not null and char_length(n) < 2 then raise exception 'Use at least 2 characters'; end if;
  select id, store_name into u from public.users where auth_uid = auth.uid() and account_type = 'business' limit 1;
  if u.id is null then raise exception 'Only business accounts have a business name'; end if;
  select m.business_name into approved from public.merchant_applications m
   where m.auth_uid = auth.uid() and m.status = 'approved' order by m.created_at desc limit 1;

  -- Not approved yet, clearing it, keeping it, or going back to the approved
  -- name: no review.
  if approved is null or n is null
     or lower(n) = lower(coalesce(u.store_name, '')) or lower(n) = lower(trim(approved)) then
    update public.users set store_name = n, store_name_pending = null, store_name_pending_at = null
     where id = u.id;
    return n;
  end if;
  update public.users set store_name_pending = n, store_name_pending_at = now() where id = u.id;
  return null;  -- null: sent for review, the current name stays
end $function$;
revoke execute on function public.set_business_name(text) from anon, public;
grant execute on function public.set_business_name(text) to authenticated;

-- The owner's name change waiting for review (null when none).
create or replace function public.my_business_name()
returns table(store_name text, pending_name text, pending_since timestamptz)
language sql stable security definer set search_path to '' as $$
  select u.store_name, u.store_name_pending, u.store_name_pending_at
    from public.users u where auth.uid() is not null and u.auth_uid = auth.uid() limit 1
$$;
revoke execute on function public.my_business_name() from anon, public;
grant execute on function public.my_business_name() to authenticated;

-- Admin panel: name changes waiting for review.
create or replace function public.admin_business_name_changes()
returns table(user_id uuid, username text, current_name text, approved_name text, pending_name text, pending_since timestamptz)
language plpgsql stable security definer set search_path to '' as $function$
begin
  if not exists (select 1 from public.admin_users a where a.id = auth.uid()) then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  return query
    select u.id, u.username::text, u.store_name::text,
           (select m.business_name from public.merchant_applications m
             where m.auth_uid = u.auth_uid and m.status = 'approved' order by m.created_at desc limit 1)::text,
           u.store_name_pending::text, u.store_name_pending_at
      from public.users u
     where u.store_name_pending is not null
     order by u.store_name_pending_at;
end $function$;
revoke execute on function public.admin_business_name_changes() from anon, public;
grant execute on function public.admin_business_name_changes() to authenticated;

create or replace function public.admin_review_business_name(p_user uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path to '' as $function$
declare u record;
begin
  if not exists (select 1 from public.admin_users a where a.id = auth.uid()) then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  select id, store_name_pending into u from public.users where id = p_user for update;
  if u.store_name_pending is null then raise exception 'No name change waiting'; end if;
  if p_approve then
    update public.users set store_name = u.store_name_pending, store_name_pending = null, store_name_pending_at = null where id = p_user;
    insert into public.notifications (user_id, type, title, message, read)
    values (p_user::text, 'business_name_approved', 'Business name approved',
            'Customers now see ' || u.store_name_pending || '.', false);
  else
    update public.users set store_name_pending = null, store_name_pending_at = null where id = p_user;
    insert into public.notifications (user_id, type, title, message, read)
    values (p_user::text, 'business_name_rejected', 'Business name not approved',
            coalesce(nullif(trim(p_note), ''), 'Your new business name was not approved. Your current name stays.'), false);
  end if;
end $function$;
revoke execute on function public.admin_review_business_name(uuid, boolean, text) from anon, public;
grant execute on function public.admin_review_business_name(uuid, boolean, text) to authenticated;
