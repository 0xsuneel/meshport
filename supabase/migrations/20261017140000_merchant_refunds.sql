-- Merchant refunds (Business → payment → Refund).
--
-- The merchant's wallet sends the refund on Arc through the MeshPortRefunds
-- contract (one refund per payment per merchant, enforced on-chain). The
-- merchant-refund edge function reads the Refunded event from the receipt,
-- checks it against the payment (merchant, customer, amount) and records it
-- here - the only writer is the service role. One row per payment.

create table if not exists public.merchant_refunds (
  id               uuid primary key default gen_random_uuid(),
  payment_id       uuid not null unique references public.merchant_payments(id) on delete cascade,
  intent_id        uuid not null references public.merchant_payment_intents(id) on delete cascade,
  merchant_auth_uid uuid not null,
  merchant_wallet  text not null,
  customer_wallet  text not null,
  customer_user_id text,
  amount           numeric not null check (amount > 0),
  reason           text not null default '' check (char_length(reason) <= 140),
  tx_hash          text not null unique,
  created_at       timestamptz not null default now()
);

create index if not exists merchant_refunds_merchant_idx on public.merchant_refunds (merchant_auth_uid, created_at desc);

alter table public.merchant_refunds enable row level security;

drop policy if exists mr_select_merchant on public.merchant_refunds;
create policy mr_select_merchant on public.merchant_refunds
  for select to authenticated using (merchant_auth_uid = auth.uid());

drop policy if exists mr_select_customer on public.merchant_refunds;
create policy mr_select_customer on public.merchant_refunds
  for select to authenticated using (
    customer_user_id is not null and exists (select 1 from public.users u where u.id::text = customer_user_id and u.auth_uid = auth.uid())
  );

drop policy if exists mr_admin on public.merchant_refunds;
create policy mr_admin on public.merchant_refunds
  for select to authenticated using (exists (select 1 from public.admin_users a where a.id = auth.uid()));

revoke insert, update, delete on public.merchant_refunds from anon, authenticated;

-- Live updates for the merchant's payments list.
do $$ begin
  alter publication supabase_realtime add table public.merchant_refunds;
exception when duplicate_object then null; when undefined_object then null; end $$;
