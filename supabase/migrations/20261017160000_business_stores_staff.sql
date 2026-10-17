-- Business → Stores & outlets, and Staff & roles.
--
-- Stores: a business account can keep several stores (outlets). Each has its
-- own name and shop QR; charges, links and bills carry the store they were
-- made for (merchant_payment_intents.store_id), so payments, statements and
-- insights can be read per store. Money still goes to the owner's wallet.
--
-- Staff: the owner invites another MeshPort user by username as a cashier
-- or manager, optionally for one store. Staff never touch the owner's money:
-- they can only create payment requests for the owner (staff_create_request)
-- and read the owner's recent payments (staff_payments). Refunds,
-- settlements and cash out stay with the owner, whose key signs them.

-- ── Stores ────────────────────────────────────────────────────────────────
create table if not exists public.business_stores (
  id              uuid primary key default gen_random_uuid(),
  owner_auth_uid  uuid not null default auth.uid(),
  name            text not null check (char_length(trim(name)) between 2 and 60),
  type            text,
  address         text check (address is null or char_length(address) <= 160),
  is_default      boolean not null default false,
  created_at      timestamptz not null default now()
);
create index if not exists business_stores_owner_idx on public.business_stores (owner_auth_uid, created_at);
create unique index if not exists business_stores_one_default on public.business_stores (owner_auth_uid) where is_default;
alter table public.business_stores enable row level security;

create policy bs_owner_select on public.business_stores for select to authenticated using (owner_auth_uid = auth.uid());
create policy bs_owner_insert on public.business_stores for insert to authenticated with check (owner_auth_uid = auth.uid());
create policy bs_owner_update on public.business_stores for update to authenticated using (owner_auth_uid = auth.uid()) with check (owner_auth_uid = auth.uid());
create policy bs_owner_delete on public.business_stores for delete to authenticated using (owner_auth_uid = auth.uid());

alter table public.merchant_payment_intents add column if not exists store_id uuid references public.business_stores(id) on delete set null;
alter table public.merchant_payment_intents add column if not exists created_by_staff uuid;

-- A request can only name one of the merchant's own stores.
create or replace function public.merchant_intents_store_check()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.store_id is not null and not exists (
    select 1 from public.business_stores s where s.id = new.store_id and s.owner_auth_uid = new.merchant_auth_uid
  ) then
    raise exception 'Unknown store';
  end if;
  return new;
end $$;
drop trigger if exists merchant_intents_store_check on public.merchant_payment_intents;
create trigger merchant_intents_store_check before insert or update of store_id on public.merchant_payment_intents
  for each row execute function public.merchant_intents_store_check();

-- ── Staff ─────────────────────────────────────────────────────────────────
create table if not exists public.business_staff (
  id              uuid primary key default gen_random_uuid(),
  owner_auth_uid  uuid not null,
  staff_auth_uid  uuid not null,
  staff_user_id   text not null,
  staff_username  text not null,
  role            text not null check (role in ('cashier', 'manager')),
  store_id        uuid references public.business_stores(id) on delete set null,
  status          text not null default 'invited' check (status in ('invited', 'active')),
  created_at      timestamptz not null default now(),
  accepted_at     timestamptz,
  unique (owner_auth_uid, staff_auth_uid)
);
alter table public.business_staff enable row level security;
create policy bstaff_owner_select on public.business_staff for select to authenticated using (owner_auth_uid = auth.uid());
create policy bstaff_self_select on public.business_staff for select to authenticated using (staff_auth_uid = auth.uid());
create policy bstaff_owner_update on public.business_staff for update to authenticated
  using (owner_auth_uid = auth.uid()) with check (owner_auth_uid = auth.uid());
create policy bstaff_owner_delete on public.business_staff for delete to authenticated using (owner_auth_uid = auth.uid() or staff_auth_uid = auth.uid());

-- Staff can read the stores of the business they work for.
create policy bs_staff_select on public.business_stores for select to authenticated using (
  exists (select 1 from public.business_staff b where b.owner_auth_uid = business_stores.owner_auth_uid and b.staff_auth_uid = auth.uid() and b.status = 'active'));

-- Owner invites a MeshPort user (by username) as cashier or manager.
create or replace function public.business_staff_invite(p_username text, p_role text, p_store uuid default null)
returns public.business_staff language plpgsql security definer set search_path = '' as $$
declare me record; them record; r public.business_staff; uname text := lower(regexp_replace(trim(coalesce(p_username, '')), '(^@|\.arc$)', '', 'g'));
begin
  select id, auth_uid, account_type, coalesce(nullif(store_name, ''), username) as shop into me from public.users where auth_uid = auth.uid() limit 1;
  if me.auth_uid is null then raise exception 'Sign in again'; end if;
  if coalesce(me.account_type, 'personal') <> 'business'
     and not exists (select 1 from public.merchant_applications m where m.auth_uid = auth.uid() and m.status = 'approved') then
    raise exception 'Only business accounts can add staff';
  end if;
  if p_role not in ('cashier', 'manager') then raise exception 'Pick a role'; end if;
  if p_store is not null and not exists (select 1 from public.business_stores s where s.id = p_store and s.owner_auth_uid = auth.uid()) then
    raise exception 'Unknown store';
  end if;
  select id, auth_uid, username into them from public.users where lower(username) = uname limit 1;
  if them.auth_uid is null then raise exception 'No MeshPort user called %.arc', uname; end if;
  if them.auth_uid = auth.uid() then raise exception 'You are already the owner'; end if;
  insert into public.business_staff (owner_auth_uid, staff_auth_uid, staff_user_id, staff_username, role, store_id)
  values (auth.uid(), them.auth_uid, them.id::text, them.username, p_role, p_store)
  on conflict (owner_auth_uid, staff_auth_uid) do update set role = excluded.role, store_id = excluded.store_id
  returning * into r;
  insert into public.notifications (user_id, type, title, message, read)
  values (them.id::text, 'business_staff_invite', 'Staff invite from ' || coalesce(me.shop, 'a business'),
          'You were invited as ' || p_role || '. Open Business to accept.', false);
  return r;
end $$;

-- A staff member accepts an invite.
create or replace function public.business_staff_accept(p_id uuid)
returns public.business_staff language plpgsql security definer set search_path = '' as $$
declare r public.business_staff;
begin
  update public.business_staff set status = 'active', accepted_at = now()
   where id = p_id and staff_auth_uid = auth.uid() returning * into r;
  if r.id is null then raise exception 'Invite not found'; end if;
  return r;
end $$;

-- The businesses this user works for, with the owner's shop name.
create or replace function public.business_staff_memberships()
returns table (id uuid, owner_auth_uid uuid, owner_name text, owner_username text, role text, status text, store_id uuid, store_name text)
language sql security definer stable set search_path = '' as $$
  select b.id, b.owner_auth_uid,
         coalesce(nullif(u.store_name, ''), (select m.business_name from public.merchant_applications m where m.auth_uid = b.owner_auth_uid and m.status = 'approved' order by m.created_at desc limit 1), u.username),
         u.username, b.role, b.status, b.store_id, s.name
    from public.business_staff b
    join public.users u on u.auth_uid = b.owner_auth_uid
    left join public.business_stores s on s.id = b.store_id
   where b.staff_auth_uid = auth.uid()
$$;

-- Staff create a payment request that pays the owner. Cashiers: amount
-- charges (up to 60 minutes). Managers: also links and bills.
create or replace function public.staff_create_request(
  p_owner uuid, p_amount numeric, p_note text default null, p_expires_minutes int default 15,
  p_store uuid default null, p_items jsonb default null, p_customer text default null)
returns public.merchant_payment_intents language plpgsql security definer set search_path = '' as $$
declare st public.business_staff; r public.merchant_payment_intents;
begin
  select * into st from public.business_staff where owner_auth_uid = p_owner and staff_auth_uid = auth.uid() and status = 'active';
  if st.id is null then raise exception 'You are not staff of this business'; end if;
  if st.role = 'cashier' and (p_items is not null or p_customer is not null or coalesce(p_expires_minutes, 0) not between 1 and 60) then
    raise exception 'Cashiers can take payments at the counter only';
  end if;
  insert into public.merchant_payment_intents (merchant_auth_uid, requested_amount, note, expires_at, store_id, items, customer_username, created_by_staff)
  values (p_owner, p_amount, nullif(trim(coalesce(p_note, '')), ''),
          case when p_expires_minutes is null or p_expires_minutes <= 0 then null else now() + make_interval(mins => p_expires_minutes) end,
          coalesce(p_store, st.store_id), p_items, nullif(trim(coalesce(p_customer, '')), ''), auth.uid())
  returning * into r;
  return r;
end $$;

-- Staff read the owner's recent payments (cashiers: today only).
create or replace function public.staff_payments(p_owner uuid, p_limit int default 100)
returns table (id uuid, intent_id uuid, source_chain text, tx_hash text, from_address text, amount numeric, status text,
               customer_username text, order_number text, created_at timestamptz, store_id uuid)
language plpgsql security definer stable set search_path = '' as $$
declare st public.business_staff;
begin
  select * into st from public.business_staff where owner_auth_uid = p_owner and staff_auth_uid = auth.uid() and status = 'active';
  if st.id is null then raise exception 'You are not staff of this business'; end if;
  return query
    select p.id, p.intent_id, p.source_chain, p.tx_hash, p.from_address, p.amount, p.status, p.customer_username, p.order_number, p.created_at, i.store_id
      from public.merchant_payments p join public.merchant_payment_intents i on i.id = p.intent_id
     where i.merchant_auth_uid = p_owner
       and (st.store_id is null or i.store_id = st.store_id)
       and (st.role = 'manager' or p.created_at >= date_trunc('day', now()))
     order by p.created_at desc limit least(greatest(p_limit, 1), 500);
end $$;

revoke all on function public.business_staff_invite(text, text, uuid), public.business_staff_accept(uuid), public.business_staff_memberships(),
  public.staff_create_request(uuid, numeric, text, int, uuid, jsonb, text), public.staff_payments(uuid, int) from public, anon;
grant execute on function public.business_staff_invite(text, text, uuid), public.business_staff_accept(uuid), public.business_staff_memberships(),
  public.staff_create_request(uuid, numeric, text, int, uuid, jsonb, text), public.staff_payments(uuid, int) to authenticated;
