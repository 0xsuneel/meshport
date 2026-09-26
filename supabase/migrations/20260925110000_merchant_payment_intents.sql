-- ═══════════════════════════════════════════════════════════════════════════
-- Merchant payment requests ("Receive payment")
--
-- A merchant (approved in merchant_applications) creates a payment request:
-- amount, optional customer, note/order id, expiry → a short code used in
-- the pay link / QR (meshport.xyz/pay/r/<code>).
--
-- Customers pay:
--   • MeshPort user with Arc USDC       → direct Arc USDC transfer (no UB)
--   • external wallet on Arc            → direct Arc USDC transfer (no UB)
--   • external wallet on a UB chain     → USDC transfer to the merchant's
--     address on that chain; the merchant's auto-collect moves it to Arc
--     with the existing Unified Balance claim (ub_claim_intents / worker).
--
-- Every payment is verified on-chain by the merchant-pay Edge Function
-- (service role) — the client never marks anything paid. One chain tx can
-- only ever be counted once (merchant_payments unique source_chain+tx_hash).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.merchant_payment_intents (
  id                 uuid        primary key default gen_random_uuid(),
  code               text        not null unique default lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
  merchant_auth_uid  uuid        not null default auth.uid(),
  merchant_user_id   text,
  merchant_wallet    text,
  merchant_name      text,
  requested_amount   numeric(20,6) not null check (requested_amount > 0 and requested_amount <= 1000000),
  received_amount    numeric(20,6) not null default 0,
  currency           text        not null default 'USDC' check (currency = 'USDC'),
  note               text        check (note is null or length(note) <= 140),
  customer_username  text,
  customer_user_id   text,
  customer_wallet    text,
  status             text        not null default 'pending'
                     check (status in ('pending','payment_detected','processing','paid','partially_paid','expired','failed','cancelled')),
  payment_method     text        check (payment_method in ('arc_direct','external_arc','external_ub')),
  source_chain       text,
  destination_chain  text        not null default 'Arc_Testnet',
  source_tx_hash     text,
  destination_tx_hash text,
  ub_intent_id       uuid,
  failure_reason     text,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz,
  paid_at            timestamptz,
  updated_at         timestamptz not null default now()
);
create index if not exists merchant_payment_intents_merchant on public.merchant_payment_intents (merchant_wallet, created_at desc);

-- Each verified on-chain payment towards a request.
create table if not exists public.merchant_payments (
  id                 uuid        primary key default gen_random_uuid(),
  intent_id          uuid        not null references public.merchant_payment_intents(id) on delete cascade,
  merchant_wallet    text        not null,
  source_chain       text        not null,
  tx_hash            text        not null,
  from_address       text        not null,
  amount             numeric(20,6) not null check (amount > 0),
  method             text        not null check (method in ('arc_direct','external_arc','external_ub')),
  status             text        not null default 'confirmed' check (status in ('confirmed','collected')),
  customer_user_id   text,
  customer_username  text,
  ub_intent_id       uuid,
  arc_tx_hash        text,
  collected_at       timestamptz,
  created_at         timestamptz not null default now(),
  unique (source_chain, tx_hash)
);
create index if not exists merchant_payments_merchant on public.merchant_payments (merchant_wallet, created_at desc);

-- Merchant identity comes from the approved application, never the client.
create or replace function public.merchant_payment_intents_before_write()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare a record;
begin
  if tg_op = 'INSERT' then
    select user_id, wallet_address, business_name into a
      from public.merchant_applications
     where auth_uid = new.merchant_auth_uid and status = 'approved'
     order by created_at desc limit 1;
    if a.wallet_address is null then
      raise exception 'Only approved merchants can create payment requests';
    end if;
    new.merchant_user_id := a.user_id;
    new.merchant_wallet  := lower(a.wallet_address);
    new.merchant_name    := a.business_name;
    new.status := 'pending'; new.received_amount := 0; new.paid_at := null;
    new.source_tx_hash := null; new.destination_tx_hash := null; new.payment_method := null;
    new.customer_wallet := null; new.ub_intent_id := null; new.failure_reason := null;
    new.customer_username := nullif(lower(regexp_replace(coalesce(new.customer_username, ''), '\.arc$', '')), '');
    new.customer_user_id := null;
    if new.customer_username is not null then
      select id::text into new.customer_user_id from public.users where lower(username) = new.customer_username limit 1;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists merchant_payment_intents_before_write on public.merchant_payment_intents;
create trigger merchant_payment_intents_before_write
  before insert or update on public.merchant_payment_intents
  for each row execute function public.merchant_payment_intents_before_write();

-- Tell the merchant when a request is paid.
create or replace function public.merchant_payment_intents_notify()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare who text;
begin
  if new.status = 'paid' and old.status is distinct from 'paid' and new.merchant_user_id is not null then
    who := coalesce(nullif(new.customer_username, ''), case when new.customer_wallet is not null
             then substr(new.customer_wallet, 1, 6) || '…' || right(new.customer_wallet, 4) end, 'A customer');
    insert into public.notifications (user_id, type, title, message, read)
    values (new.merchant_user_id, 'merchant_payment_received', 'Payment received',
            who || ' paid you $' || trim(to_char(new.received_amount, 'FM999999990.00')) || ' USDC'
              || coalesce(' · ' || nullif(new.note, ''), ''), false);
  end if;
  return new;
end;
$$;

drop trigger if exists merchant_payment_intents_notify on public.merchant_payment_intents;
create trigger merchant_payment_intents_notify
  after update on public.merchant_payment_intents
  for each row execute function public.merchant_payment_intents_notify();

-- When the merchant's Unified Balance collection from a chain completes, the
-- payments that were waiting on that chain have landed on Arc.
create or replace function public.merchant_payments_mark_collected()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  chain text := case when new.source_chain = 'Polygon_Amoy_Testnet' then 'Polygon_Sepolia' else new.source_chain end;
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    update public.merchant_payments p
       set status = 'collected', collected_at = now(), ub_intent_id = new.id, arc_tx_hash = lower(new.mint_tx)
     where p.merchant_wallet = lower(new.wallet_address)
       and p.source_chain = chain
       and p.status = 'confirmed'
       and p.method = 'external_ub'
       and p.created_at <= new.created_at + interval '2 minutes';

    update public.merchant_payment_intents i
       set status = 'paid', paid_at = coalesce(i.paid_at, now()),
           destination_tx_hash = coalesce(i.destination_tx_hash, lower(new.mint_tx)),
           ub_intent_id = coalesce(i.ub_intent_id, new.id)
     where i.merchant_wallet = lower(new.wallet_address)
       and i.status = 'processing'
       and i.received_amount >= i.requested_amount * 0.999
       and not exists (select 1 from public.merchant_payments p where p.intent_id = i.id and p.status = 'confirmed' and p.method = 'external_ub');
  end if;
  return new;
end;
$$;

drop trigger if exists ub_claim_intents_merchant_collected on public.ub_claim_intents;
create trigger ub_claim_intents_merchant_collected
  after update on public.ub_claim_intents
  for each row execute function public.merchant_payments_mark_collected();

alter table public.merchant_payment_intents enable row level security;
alter table public.merchant_payments enable row level security;

drop policy if exists mpi_insert_own on public.merchant_payment_intents;
drop policy if exists mpi_select_own on public.merchant_payment_intents;
drop policy if exists mpi_admin on public.merchant_payment_intents;
drop policy if exists mp_select_own on public.merchant_payments;
drop policy if exists mp_admin on public.merchant_payments;

-- Merchants create and read their own requests. Everything else (paying,
-- status changes, cancel) goes through the merchant-pay Edge Function.
create policy mpi_insert_own on public.merchant_payment_intents
  for insert with check (auth.uid() is not null and merchant_auth_uid = auth.uid());
create policy mpi_select_own on public.merchant_payment_intents
  for select using (merchant_auth_uid = auth.uid());
create policy mpi_admin on public.merchant_payment_intents
  for select using (exists (select 1 from public.admin_users a where a.id = auth.uid()));

create policy mp_select_own on public.merchant_payments
  for select using (exists (select 1 from public.merchant_payment_intents i where i.id = intent_id and i.merchant_auth_uid = auth.uid()));
create policy mp_admin on public.merchant_payments
  for select using (exists (select 1 from public.admin_users a where a.id = auth.uid()));

alter publication supabase_realtime add table public.merchant_payment_intents;
alter publication supabase_realtime add table public.merchant_payments;
