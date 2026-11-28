-- Credit book, staff attendance and staff payment alerts (28 Nov, like Paytm's
-- Khata and staff tools).

-- ── Credit book: what each customer owes (or has paid in advance) ──────────
create table if not exists public.business_ledger_customers (
  id             uuid primary key default gen_random_uuid(),
  owner_auth_uid uuid not null default auth.uid(),
  name           text not null check (char_length(trim(name)) between 1 and 80),
  contact        text check (contact is null or char_length(contact) <= 120),
  username       text check (username is null or char_length(username) <= 40),
  created_at     timestamptz not null default now()
);
create index if not exists business_ledger_customers_owner_idx on public.business_ledger_customers(owner_auth_uid);
alter table public.business_ledger_customers enable row level security;
drop policy if exists ledger_customers_owner on public.business_ledger_customers;
create policy ledger_customers_owner on public.business_ledger_customers for all to authenticated
  using (owner_auth_uid = auth.uid()) with check (owner_auth_uid = auth.uid());

-- 'credit' = they took goods on credit (you'll get it); 'payment' = they paid.
create table if not exists public.business_ledger_entries (
  id             uuid primary key default gen_random_uuid(),
  owner_auth_uid uuid not null default auth.uid(),
  customer_id    uuid not null references public.business_ledger_customers(id) on delete cascade,
  kind           text not null check (kind in ('credit', 'payment')),
  amount         numeric not null check (amount > 0 and amount <= 1000000),
  note           text check (note is null or char_length(note) <= 140),
  intent_id      uuid references public.merchant_payment_intents(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists business_ledger_entries_customer_idx on public.business_ledger_entries(customer_id, created_at desc);
alter table public.business_ledger_entries enable row level security;
drop policy if exists ledger_entries_owner on public.business_ledger_entries;
create policy ledger_entries_owner on public.business_ledger_entries for all to authenticated
  using (owner_auth_uid = auth.uid())
  with check (owner_auth_uid = auth.uid()
              and exists (select 1 from public.business_ledger_customers c where c.id = customer_id and c.owner_auth_uid = auth.uid()));

-- A pay link sent from the credit book: when it's paid, the payment is entered for you.
alter table public.merchant_payment_intents
  add column if not exists ledger_customer_id uuid references public.business_ledger_customers(id) on delete set null;

create or replace function public.ledger_enter_payment()
returns trigger language plpgsql security definer set search_path to '' as $function$
begin
  if new.ledger_customer_id is not null and new.received_amount > coalesce(old.received_amount, 0)
     and exists (select 1 from public.business_ledger_customers c where c.id = new.ledger_customer_id and c.owner_auth_uid = new.merchant_auth_uid) then
    insert into public.business_ledger_entries (owner_auth_uid, customer_id, kind, amount, note, intent_id)
    values (new.merchant_auth_uid, new.ledger_customer_id, 'payment', new.received_amount - coalesce(old.received_amount, 0),
            'Paid by MeshPort', new.id);
  end if;
  return new;
end $function$;
drop trigger if exists ledger_enter_payment on public.merchant_payment_intents;
create trigger ledger_enter_payment after update of received_amount on public.merchant_payment_intents
  for each row execute function public.ledger_enter_payment();

-- ── Staff attendance: check in / check out ─────────────────────────────────
create table if not exists public.business_attendance (
  id             uuid primary key default gen_random_uuid(),
  owner_auth_uid uuid not null,
  staff_auth_uid uuid not null,
  counter_id     uuid references public.business_counters(id) on delete set null,
  check_in       timestamptz not null default now(),
  check_out      timestamptz,
  in_lat         double precision,
  in_lng         double precision
);
create index if not exists business_attendance_owner_idx on public.business_attendance(owner_auth_uid, check_in desc);
create index if not exists business_attendance_staff_idx on public.business_attendance(staff_auth_uid, check_in desc);
alter table public.business_attendance enable row level security;
drop policy if exists attendance_read on public.business_attendance;
create policy attendance_read on public.business_attendance for select to authenticated
  using (owner_auth_uid = auth.uid() or staff_auth_uid = auth.uid());

-- Check in (only active staff of that business; one open check-in at a time).
create or replace function public.staff_check_in(p_owner uuid, p_lat double precision default null, p_lng double precision default null)
returns void language plpgsql security definer set search_path to '' as $function$
declare ct uuid;
begin
  if not exists (select 1 from public.business_staff s where s.owner_auth_uid = p_owner and s.staff_auth_uid = auth.uid() and s.status = 'active') then
    raise exception 'You are not staff here';
  end if;
  if exists (select 1 from public.business_attendance a where a.owner_auth_uid = p_owner and a.staff_auth_uid = auth.uid() and a.check_out is null) then
    return;
  end if;
  select c.id into ct from public.business_counters c where c.owner_auth_uid = p_owner and auth.uid() = any(c.staff_uids) order by c.created_at limit 1;
  insert into public.business_attendance (owner_auth_uid, staff_auth_uid, counter_id, in_lat, in_lng)
  values (p_owner, auth.uid(), ct, p_lat, p_lng);
end $function$;

create or replace function public.staff_check_out(p_owner uuid)
returns void language plpgsql security definer set search_path to '' as $function$
begin
  update public.business_attendance set check_out = now()
   where owner_auth_uid = p_owner and staff_auth_uid = auth.uid() and check_out is null;
end $function$;
revoke execute on function public.staff_check_in(uuid, double precision, double precision) from anon, public;
revoke execute on function public.staff_check_out(uuid) from anon, public;
grant execute on function public.staff_check_in(uuid, double precision, double precision) to authenticated;
grant execute on function public.staff_check_out(uuid) to authenticated;

-- ── Payment alerts for staff, at their counter ─────────────────────────────
alter table public.business_staff add column if not exists payment_alerts boolean not null default false;

create or replace function public.staff_payment_alerts()
returns trigger language plpgsql security definer set search_path to '' as $function$
declare i record; s record;
begin
  select x.merchant_auth_uid, x.counter_id, c.name as counter_name, c.staff_uids into i
    from public.merchant_payment_intents x left join public.business_counters c on c.id = x.counter_id
   where x.id = new.intent_id;
  if i.counter_id is null or coalesce(new.screen_flag, '') <> '' then return new; end if;
  for s in select bs.staff_user_id from public.business_staff bs
            where bs.owner_auth_uid = i.merchant_auth_uid and bs.status = 'active' and bs.payment_alerts
              and bs.staff_auth_uid = any(i.staff_uids) and bs.staff_user_id is not null
  loop
    insert into public.notifications (user_id, type, title, message, read)
    values (s.staff_user_id::text, 'business_staff_payment', 'Received $' || trim(to_char(new.amount, 'FM999,999,990.00')),
            'Paid at ' || i.counter_name || coalesce(' by ' || new.customer_username || '.arc', '') || '.', false);
  end loop;
  return new;
exception when others then return new;
end $function$;
drop trigger if exists staff_payment_alerts on public.merchant_payments;
create trigger staff_payment_alerts after insert on public.merchant_payments
  for each row execute function public.staff_payment_alerts();
