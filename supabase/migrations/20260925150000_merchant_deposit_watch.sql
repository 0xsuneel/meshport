-- Direct-deposit watcher for merchant orders.
--
-- Customers who send USDC straight to a merchant's address (MetaMask, OKX,
-- any wallet — not through the pay link) leave no order number on-chain.
-- merchant-pay's 'watch' action (cron, every minute) reads USDC Transfer
-- logs to merchant addresses on Arc (native system emitter, per Arc docs)
-- and on the Unified Balance chains, then:
--   • exactly one open order of that merchant is due that exact amount (and,
--     if the order names a customer, the sender is that customer's wallet)
--     → the payment is recorded against that order (matched_by = 'watcher');
--   • several open orders match → the deposit waits for the merchant to pick
--     the order ("needs review"); nothing is guessed.
--   • no open order matches → ignored (an ordinary transfer).

-- Where each chain's scan got to.
create table if not exists public.merchant_deposit_cursors (
  chain       text primary key,
  last_block  bigint not null,
  updated_at  timestamptz not null default now()
);
alter table public.merchant_deposit_cursors enable row level security;
-- No policies: only the service role (merchant-pay) reads / writes it.

-- How a payment was linked to its order.
alter table public.merchant_payments add column if not exists matched_by text
  check (matched_by in ('customer', 'merchant', 'watcher'));

-- Deposits that matched more than one open order.
create table if not exists public.merchant_unmatched_deposits (
  id               uuid primary key default gen_random_uuid(),
  merchant_wallet  text not null,
  source_chain     text not null,
  tx_hash          text not null,
  from_address     text not null,
  amount           numeric(20, 6) not null,
  candidate_codes  text[] not null default '{}',
  status           text not null default 'needs_review' check (status in ('needs_review', 'assigned', 'dismissed')),
  assigned_code    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (source_chain, tx_hash)
);
create index if not exists merchant_unmatched_deposits_merchant
  on public.merchant_unmatched_deposits (merchant_wallet, status, created_at desc);
alter table public.merchant_unmatched_deposits enable row level security;

drop policy if exists mud_select_own on public.merchant_unmatched_deposits;
create policy mud_select_own on public.merchant_unmatched_deposits
  for select using (exists (
    select 1 from public.merchant_applications a
     where a.auth_uid = auth.uid() and a.status = 'approved' and a.wallet_address = merchant_unmatched_deposits.merchant_wallet
  ));
drop policy if exists mud_admin on public.merchant_unmatched_deposits;
create policy mud_admin on public.merchant_unmatched_deposits
  for select using (exists (select 1 from public.admin_users a where a.id = auth.uid()));

-- Tell the merchant a deposit needs them to pick the order.
create or replace function public.merchant_unmatched_notify()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform public.merchant_notify(
    new.merchant_wallet, 'merchant_payment_review',
    'Payment needs review',
    '$' || trim(to_char(new.amount, 'FM999999990.00')) || ' USDC arrived on ' || public.merchant_chain_label(new.source_chain)
      || ' and matches more than one open order. Open Ledger to pick the order.'
  );
  return new;
end;
$$;
drop trigger if exists merchant_unmatched_notify on public.merchant_unmatched_deposits;
create trigger merchant_unmatched_notify
  after insert on public.merchant_unmatched_deposits
  for each row execute function public.merchant_unmatched_notify();

do $$ begin
  alter publication supabase_realtime add table public.merchant_unmatched_deposits;
exception when duplicate_object then null; end $$;

-- Run the watcher every minute (same service-key pattern as ub-claim-worker).
select cron.unschedule(jobid) from cron.job where jobname = 'merchant-deposit-watch';
select cron.schedule('merchant-deposit-watch', '* * * * *', $cron$
  select net.http_post(
    url := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/merchant-pay',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'claim_worker_service_key')
    ),
    body := jsonb_build_object('action', 'watch')
  );
$cron$);
