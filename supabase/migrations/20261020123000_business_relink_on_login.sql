-- Business data (stores/branches, staff, saved items, payouts, activity log
-- and refund history) stays with the account across sign-ins.
--
-- Background: every business table keys its rows on the owner's LOGIN id
-- (owner_auth_uid / merchant_auth_uid = auth.uid()), guarded by RLS
-- owner_auth_uid = auth.uid(). Wallet / guest users get a BRAND-NEW auth_uid
-- every time they sign in again (a fresh anonymous session), and bind-session
-- re-points users.auth_uid to it. merchant_relink_owner() already moved the
-- merchant tables (application, auto-convert setting, payment requests) to the
-- new id, because those carry a stable user_id / wallet. But the multi-store
-- feature - business_stores (branches), business_staff, business_items,
-- business_payouts, business_activity_log - and merchant_refunds were added
-- later and carry ONLY owner_auth_uid. So after a business owner logged out and
-- back in (or their guest session simply expired after a few days), their
-- branches, staff, saved items, payouts, activity and refund history all
-- vanished: the rows were never deleted, only stranded on the previous login id
-- and hidden by RLS.
--
-- Fix: when a users row's auth_uid changes, also move these business rows from
-- the previous login id to the new one. Plus a one-time repair of rows already
-- stranded, mapped back to their owner through the orders that reference their
-- store (orders already carry the current login id).

-- business_staff_guard blocks any change to owner_auth_uid / staff_auth_uid
-- ("Invite the new person instead"). Let the relink move them while it runs:
-- meshport.merchant_relink is a transaction-local flag only our security-
-- definer relink functions set - clients can't, and only admins may write the
-- table anyway.
create or replace function public.business_staff_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('meshport.merchant_relink', true), '') = 'on' then return new; end if;
  if new.owner_auth_uid <> old.owner_auth_uid or new.staff_auth_uid <> old.staff_auth_uid then
    raise exception 'Invite the new person instead';
  end if;
  if new.status = 'active' and old.status <> 'active' and auth.uid() is distinct from old.staff_auth_uid then
    raise exception 'Only the invited person can accept';
  end if;
  return new;
end $$;

-- Move every business row from one login id to another: the owner's stores,
-- staff roster, items, payouts, activity and refunds, plus this login's OWN
-- staff membership in someone else's business. Keeps a single default store and
-- respects unique (owner_auth_uid, staff_auth_uid).
create or replace function public.business_relink_login(p_old uuid, p_new uuid)
returns void language plpgsql security definer set search_path = 'public'
as $$
begin
  if p_old is null or p_new is null or p_old = p_new then return; end if;
  perform set_config('meshport.merchant_relink', 'on', true);

  -- Don't end up with two default stores for the new owner.
  if exists (select 1 from business_stores where owner_auth_uid = p_new and is_default) then
    update business_stores set is_default = false where owner_auth_uid = p_old and is_default;
  end if;
  update business_stores      set owner_auth_uid = p_new where owner_auth_uid = p_old;

  -- Owner's staff roster (skip a staff member already present on the new id).
  update business_staff s set owner_auth_uid = p_new
   where s.owner_auth_uid = p_old
     and not exists (select 1 from business_staff t where t.owner_auth_uid = p_new and t.staff_auth_uid = s.staff_auth_uid);
  -- This user's own membership in another business.
  update business_staff s set staff_auth_uid = p_new
   where s.staff_auth_uid = p_old
     and not exists (select 1 from business_staff t where t.owner_auth_uid = s.owner_auth_uid and t.staff_auth_uid = p_new);

  update business_items        set owner_auth_uid = p_new where owner_auth_uid = p_old;
  update business_payouts      set owner_auth_uid = p_new where owner_auth_uid = p_old;
  update business_activity_log set owner_auth_uid = p_new where owner_auth_uid = p_old;
  update merchant_refunds      set merchant_auth_uid = p_new where merchant_auth_uid = p_old;

  -- Belt and braces: never leave two defaults for the new owner.
  update business_stores set is_default = false
   where owner_auth_uid = p_new and is_default
     and id <> (select id from business_stores where owner_auth_uid = p_new and is_default order by created_at limit 1);

  perform set_config('meshport.merchant_relink', 'off', true);
end $$;
revoke all on function public.business_relink_login(uuid, uuid) from public, anon, authenticated;

-- Extend the users relink trigger to also move the business rows old -> new.
create or replace function public.users_merchant_relink()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
begin
  if new.auth_uid is not null and (tg_op = 'INSERT' or new.auth_uid is distinct from old.auth_uid) then
    perform public.merchant_relink_owner(new.id, new.auth_uid, new.wallet_address);
    if tg_op = 'UPDATE' and old.auth_uid is not null and old.auth_uid is distinct from new.auth_uid then
      perform public.business_relink_login(old.auth_uid, new.auth_uid);
    end if;
  end if;
  return new;
end $$;

-- One-time repair: rows stranded on an old login id, mapped back to their owner
-- through an order that already carries the current login id - either a branch's
-- order (business_stores.id = intent.store_id) or a refunded payment's order
-- (refund -> payment -> intent). Everything else sharing that old id (staff,
-- items, payouts, activity, refunds) moves with it.
do $$
declare m record;
begin
  for m in
    select distinct s.owner_auth_uid as old_uid, i.merchant_auth_uid as new_uid
      from public.business_stores s
      join public.merchant_payment_intents i on i.store_id = s.id
      join public.users u on u.auth_uid = i.merchant_auth_uid
     where s.owner_auth_uid <> i.merchant_auth_uid
    union
    select distinct r.merchant_auth_uid as old_uid, i.merchant_auth_uid as new_uid
      from public.merchant_refunds r
      join public.merchant_payments p on p.id = r.payment_id
      join public.merchant_payment_intents i on i.id = p.intent_id
      join public.users u on u.auth_uid = i.merchant_auth_uid
     where r.merchant_auth_uid <> i.merchant_auth_uid
  loop
    perform public.business_relink_login(m.old_uid, m.new_uid);
  end loop;
end $$;
