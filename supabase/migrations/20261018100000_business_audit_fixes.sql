-- Business account audit fixes.

-- Staff take payments only for an approved business, and a cashier tied to
-- one store can't take them for another.
create or replace function public.staff_create_request(p_owner uuid, p_amount numeric, p_note text default null, p_expires_minutes integer default 15, p_store uuid default null, p_items jsonb default null, p_customer text default null)
returns public.merchant_payment_intents language plpgsql security definer set search_path = '' as $function$
declare st public.business_staff; r public.merchant_payment_intents;
begin
  select * into st from public.business_staff where owner_auth_uid = p_owner and staff_auth_uid = auth.uid() and status = 'active';
  if st.id is null then raise exception 'You are not staff of this business'; end if;
  if not exists (select 1 from public.merchant_applications a where a.auth_uid = p_owner and a.status = 'approved') then
    raise exception 'This business is not approved yet';
  end if;
  if p_amount is null or p_amount < 0.01 or p_amount > 100000 then raise exception 'Enter an amount between $0.01 and $100,000'; end if;
  if st.store_id is not null and p_store is not null and p_store <> st.store_id then raise exception 'You can only take payments for your store'; end if;
  if st.role = 'cashier' and (p_items is not null or p_customer is not null or coalesce(p_expires_minutes, 0) not between 1 and 60) then
    raise exception 'Cashiers can take payments at the counter only';
  end if;
  insert into public.merchant_payment_intents (merchant_auth_uid, requested_amount, note, expires_at, store_id, items, customer_username, created_by_staff)
  values (p_owner, p_amount, nullif(trim(coalesce(p_note, '')), ''),
          case when p_expires_minutes is null or p_expires_minutes <= 0 then null else now() + make_interval(mins => p_expires_minutes) end,
          coalesce(p_store, st.store_id), p_items, nullif(trim(coalesce(p_customer, '')), ''), auth.uid())
  returning * into r;
  return r;
end $function$;

do $$
declare d text;
begin
  select pg_get_functiondef('public.staff_payments(uuid, integer)'::regprocedure) into d;
  d := replace(d, $r$  if st.id is null then raise exception 'You are not staff of this business'; end if;$r$,
    $r$  if st.id is null then raise exception 'You are not staff of this business'; end if;
  if not exists (select 1 from public.merchant_applications a where a.auth_uid = p_owner and a.status = 'approved') then
    raise exception 'This business is not approved yet';
  end if;$r$);
  execute d;
end $$;

-- The owner can change a staff member's role and store, but not who they
-- are, and can't accept an invite for them.
create or replace function public.business_staff_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.owner_auth_uid <> old.owner_auth_uid or new.staff_auth_uid <> old.staff_auth_uid then
    raise exception 'Invite the new person instead';
  end if;
  if new.status = 'active' and old.status <> 'active' and auth.uid() is distinct from old.staff_auth_uid then
    raise exception 'Only the invited person can accept';
  end if;
  return new;
end $$;
drop trigger if exists business_staff_guard on public.business_staff;
create trigger business_staff_guard before update on public.business_staff
  for each row execute function public.business_staff_guard();

-- One refund per transfer: a payment and the plain receive of the same
-- transaction are the same money.
create or replace function public.merchant_refunds_one_per_tx()
returns trigger language plpgsql security definer set search_path = '' as $$
declare c text; t text;
begin
  if new.payment_id is not null then
    select source_chain, lower(tx_hash) into c, t from public.merchant_payments where id = new.payment_id;
  elsif new.receipt_id is not null then
    select source_chain, lower(tx_hash) into c, t from public.merchant_chain_receipts where id = new.receipt_id;
  end if;
  if t is not null and exists (
    select 1 from public.merchant_refunds r
      left join public.merchant_payments p on p.id = r.payment_id
      left join public.merchant_chain_receipts k on k.id = r.receipt_id
     where r.id is distinct from new.id
       and coalesce(p.source_chain, k.source_chain) = c and lower(coalesce(p.tx_hash, k.tx_hash)) = t) then
    raise exception 'This payment was already refunded';
  end if;
  return new;
end $$;
drop trigger if exists merchant_refunds_one_per_tx on public.merchant_refunds;
create trigger merchant_refunds_one_per_tx before insert on public.merchant_refunds
  for each row execute function public.merchant_refunds_one_per_tx();

-- A saved payout with a bad amount no longer stops everyone's reminders;
-- due dates are India dates.
create or replace function public.business_payout_reminders()
returns void language plpgsql security definer set search_path = '' as $function$
declare p record;
begin
  for p in
    select b.id, b.name, b.next_due, u.id as user_id,
           (select coalesce(sum(case when (r->>'amount') ~ '^\s*\d+(\.\d+)?\s*$' then (r->>'amount')::numeric else 0 end), 0)
              from jsonb_array_elements(b.recipients) r) as total,
           jsonb_array_length(b.recipients) as n
      from public.business_payouts b join public.users u on u.auth_uid = b.owner_auth_uid
     where b.next_due is not null and b.next_due <= (now() at time zone 'Asia/Kolkata')::date
       and b.reminded_for is distinct from b.next_due
  loop
    insert into public.notifications (user_id, type, title, message, read)
    values (p.user_id::text, 'business_payout_due', p.name || ' is due',
            'Pay $' || to_char(p.total, 'FM999,999,990.00') || ' to ' || p.n || case when p.n = 1 then ' person' else ' people' end || ' - open Business → Payouts.', false);
    update public.business_payouts set reminded_for = p.next_due where id = p.id;
  end loop;
end $function$;

-- Business names: no invisible or control characters.
create or replace function public.set_business_name(p_name text)
returns text language plpgsql security definer set search_path = '' as $function$
declare n text := nullif(left(regexp_replace(regexp_replace(trim(coalesce(p_name, '')),
  '[\u0001-\u001F\u007F​-‏‪-‮⁠-⁤﻿]', '', 'g'), '\s+', ' ', 'g'), 60), '');
begin
  if n is not null and char_length(n) < 2 then raise exception 'Use at least 2 characters'; end if;
  update public.users set store_name = n where auth_uid = auth.uid() and account_type = 'business';
  if not found then raise exception 'Only business accounts have a business name'; end if;
  return n;
end $function$;

-- Signed-in only (the cron job runs as the owner).
revoke execute on function public.business_payout_reminders() from anon, authenticated, public;
revoke execute on function public.set_business_name(text) from anon, public;
revoke execute on function public.staff_create_request(uuid, numeric, text, integer, uuid, jsonb, text) from anon, public;
revoke execute on function public.staff_payments(uuid, integer) from anon, public;
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('set_shop_limits', 'business_payout_paid', 'business_items_remember')
  loop
    execute format('revoke execute on function %s from anon, public', f.sig);
  end loop;
  -- Trigger functions are never called directly.
  for f in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype
              and (p.proname like 'merchant%' or p.proname like 'business%')
  loop
    execute format('revoke execute on function %s from anon, authenticated, public', f.sig);
  end loop;
end $$;

create index if not exists merchant_payments_intent_id_idx on public.merchant_payments (intent_id);
