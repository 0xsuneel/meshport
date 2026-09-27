-- Merchant data stays with the account across sign-ins.
--
-- Merchant rows are owned by the login id (auth_uid): the application, the
-- auto-convert setting and payment requests (payments / receipts / review
-- items follow through those). Signing in again — private key, recovery
-- phrase, Google or email OTP — gives the same users row a NEW auth_uid, so
-- an approved merchant looked like "no application" and had to apply again.
--
-- Fix: when a users row gets a (new) auth_uid, move every merchant row that
-- belongs to that user (by user id or wallet) to the new auth_uid. Plus a
-- one-time repair of the rows already left behind.

create or replace function public.merchant_relink_owner(p_user_id uuid, p_auth_uid uuid, p_wallet text)
returns void language plpgsql security definer set search_path to 'public'
as $$
declare w text := lower(nullif(p_wallet, ''));
begin
  if p_auth_uid is null then return; end if;

  -- Application(s). If an application was already re-submitted under the new
  -- login while the earlier one is still open, the re-submitted duplicate is
  -- closed (only one open application per login is allowed).
  if exists (select 1 from merchant_applications
              where auth_uid is distinct from p_auth_uid and status in ('pending', 'approved')
                and (user_id = p_user_id::text or (w is not null and lower(wallet_address) = w))) then
    update merchant_applications
       set status = 'rejected', review_note = 'Duplicate — merged with your existing merchant application', updated_at = now()
     where auth_uid = p_auth_uid and status = 'pending';
  end if;
  update merchant_applications
     set auth_uid = p_auth_uid
   where auth_uid is distinct from p_auth_uid
     and (user_id = p_user_id::text or (w is not null and lower(wallet_address) = w));

  -- Auto-convert setting (one row per login): keep a setting already made
  -- under the new login, otherwise move the old one over.
  if w is not null then
    if exists (select 1 from merchant_auto_convert where auth_uid = p_auth_uid) then
      delete from merchant_auto_convert where auth_uid <> p_auth_uid and lower(wallet_address) = w;
    else
      update merchant_auto_convert set auth_uid = p_auth_uid
       where auth_uid = (select auth_uid from merchant_auto_convert where lower(wallet_address) = w and auth_uid <> p_auth_uid
                          order by updated_at desc nulls last limit 1);
      delete from merchant_auto_convert where auth_uid <> p_auth_uid and lower(wallet_address) = w;
    end if;
  end if;

  -- Payment requests (their payments, receipts and review items follow).
  update merchant_payment_intents
     set merchant_auth_uid = p_auth_uid
   where merchant_auth_uid is distinct from p_auth_uid
     and (merchant_user_id = p_user_id::text or (w is not null and lower(merchant_wallet) = w));
end $$;

create or replace function public.users_merchant_relink()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
begin
  if new.auth_uid is not null and (tg_op = 'INSERT' or new.auth_uid is distinct from old.auth_uid) then
    perform public.merchant_relink_owner(new.id, new.auth_uid, new.wallet_address);
  end if;
  return new;
end $$;

drop trigger if exists users_merchant_relink on public.users;
create trigger users_merchant_relink
  after insert or update of auth_uid on public.users
  for each row execute function public.users_merchant_relink();

revoke all on function public.merchant_relink_owner(uuid, uuid, text) from public, anon, authenticated;

-- One-time repair: every account whose merchant rows are on an old login id.
do $$
declare u record;
begin
  for u in
    select distinct us.id, us.auth_uid, us.wallet_address
      from users us
     where us.auth_uid is not null and (
       exists (select 1 from merchant_applications a where a.auth_uid is distinct from us.auth_uid
                and (a.user_id = us.id::text or lower(a.wallet_address) = lower(us.wallet_address)))
       or exists (select 1 from merchant_payment_intents i where i.merchant_auth_uid is distinct from us.auth_uid
                and (i.merchant_user_id = us.id::text or lower(i.merchant_wallet) = lower(us.wallet_address)))
       or exists (select 1 from merchant_auto_convert c where c.auth_uid is distinct from us.auth_uid
                and lower(c.wallet_address) = lower(us.wallet_address)))
  loop
    perform public.merchant_relink_owner(u.id, u.auth_uid, u.wallet_address);
  end loop;
end $$;

-- ── Applied live as a second step (merchant_relink_allow_owner_move) ──────────
-- merchant_applications_before_write() locks auth_uid on every update. It now
-- lets the owner's login id move ONLY while merchant_relink_owner() runs (it
-- sets the transaction-local flag meshport.merchant_relink = 'on'; clients
-- can't set it, and only admins may update the table anyway), and
-- merchant_applications_notify() sends nothing for that move. The live
-- definitions of those two functions and of merchant_relink_owner() are:
create or replace function public.merchant_applications_before_write()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare u record; relink boolean := coalesce(current_setting('meshport.merchant_relink', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    select id, wallet_address, username into u from public.users where auth_uid = new.auth_uid limit 1;
    if u.id is null then
      raise exception 'No MeshPort account found for this session';
    end if;
    new.user_id        := u.id::text;
    new.wallet_address := lower(u.wallet_address);
    new.username       := u.username;
    new.status         := 'pending';
    new.review_note    := null;
    new.reviewed_by    := null;
    new.reviewed_at    := null;
  else
    if not relink then new.auth_uid := old.auth_uid; end if;
    new.user_id := old.user_id;
    new.wallet_address := old.wallet_address; new.username := old.username;
    new.business_name := old.business_name; new.business_type := old.business_type;
    new.contact := old.contact; new.description := old.description;
    if new.status is distinct from old.status then new.reviewed_at := now(); end if;
  end if;
  new.updated_at := now();
  return new;
end;
$function$;

create or replace function public.merchant_applications_notify()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  if coalesce(current_setting('meshport.merchant_relink', true), '') = 'on' then return new; end if;
  if new.status is distinct from old.status and new.user_id is not null then
    if new.status = 'approved' then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.user_id, 'merchant_approved', 'Merchant account approved',
              'You can now receive payments as ' || new.business_name || '. Open Multichain Hub → Ledger.', false);
    elsif new.status = 'rejected' then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.user_id, 'merchant_rejected', 'Merchant application not approved',
              coalesce(nullif(trim(new.review_note), ''), 'Your merchant application was not approved.'), false);
    elsif new.status = 'revoked' then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.user_id, 'merchant_revoked', 'Merchant access removed',
              coalesce(nullif(trim(new.review_note), ''), 'Your merchant access was removed by MeshPort.'), false);
    end if;
  end if;
  return new;
end;
$function$;

create or replace function public.merchant_relink_owner(p_user_id uuid, p_auth_uid uuid, p_wallet text)
returns void language plpgsql security definer set search_path to 'public'
as $$
declare w text := lower(nullif(p_wallet, ''));
begin
  if p_auth_uid is null then return; end if;
  perform set_config('meshport.merchant_relink', 'on', true);
  if exists (select 1 from merchant_applications
              where auth_uid is distinct from p_auth_uid and status in ('pending', 'approved')
                and (user_id = p_user_id::text or (w is not null and lower(wallet_address) = w))) then
    update merchant_applications
       set status = 'rejected', review_note = 'Duplicate — merged with your existing merchant application'
     where auth_uid = p_auth_uid and status = 'pending';
  end if;
  update merchant_applications set auth_uid = p_auth_uid
   where auth_uid is distinct from p_auth_uid
     and (user_id = p_user_id::text or (w is not null and lower(wallet_address) = w));
  if w is not null then
    if exists (select 1 from merchant_auto_convert where auth_uid = p_auth_uid) then
      delete from merchant_auto_convert where auth_uid <> p_auth_uid and lower(wallet_address) = w;
    else
      update merchant_auto_convert set auth_uid = p_auth_uid
       where auth_uid = (select auth_uid from merchant_auto_convert where lower(wallet_address) = w and auth_uid <> p_auth_uid
                          order by updated_at desc nulls last limit 1);
      delete from merchant_auto_convert where auth_uid <> p_auth_uid and lower(wallet_address) = w;
    end if;
  end if;
  update merchant_payment_intents set merchant_auth_uid = p_auth_uid
   where merchant_auth_uid is distinct from p_auth_uid
     and (merchant_user_id = p_user_id::text or (w is not null and lower(merchant_wallet) = w));
  perform set_config('meshport.merchant_relink', 'off', true);
end $$;
revoke all on function public.merchant_relink_owner(uuid, uuid, text) from public, anon, authenticated;
