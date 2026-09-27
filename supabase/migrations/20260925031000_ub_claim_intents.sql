-- Bring Funds via Unified Balance, finished server-side (ub-claim-worker).
-- The device deposits on the source chain and signs the Gateway burn intent
-- (recipient = the user's own Arc wallet); the worker submits that signed
-- intent once the deposit is finalized and Circle's forwarder mints on Arc.
-- No private key ever leaves the device.
create table if not exists public.ub_claim_intents (
  id             uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  source_chain   text not null,
  amount         numeric not null,
  send_amount    numeric,
  deposit_tx     text,
  transfer_body  jsonb not null,
  status         text not null default 'waiting'
                 check (status in ('waiting','submitted','completed','failed','expired')),
  transfer_id    text,
  mint_tx        text,
  attempts       int not null default 0,
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  completed_at   timestamptz
);
create index if not exists ub_claim_intents_open_idx on public.ub_claim_intents (status, created_at) where status in ('waiting','submitted');
create index if not exists ub_claim_intents_wallet_idx on public.ub_claim_intents (lower(wallet_address), created_at desc);
create unique index if not exists ub_claim_intents_deposit_uq on public.ub_claim_intents (lower(deposit_tx)) where deposit_tx is not null;

alter table public.ub_claim_intents enable row level security;

create policy ub_claim_intents_insert on public.ub_claim_intents for insert
  with check (status = 'waiting' and exists (
    select 1 from users u where (u.auth_uid = auth.uid() or u.auth_uid is null)
      and lower(u.wallet_address) = lower(ub_claim_intents.wallet_address)));
create policy ub_claim_intents_select on public.ub_claim_intents for select
  using (exists (
    select 1 from users u where (u.auth_uid = auth.uid() or u.auth_uid is null)
      and lower(u.wallet_address) = lower(ub_claim_intents.wallet_address)));

create trigger ub_claim_intents_updated_at before update on public.ub_claim_intents
  for each row execute function public.update_updated_at();

-- Every minute (same pattern as claim-worker-sweep).
select cron.schedule('ub-claim-worker-sweep', '* * * * *', $$
  select net.http_post(
    url := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/ub-claim-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'claim_worker_service_key')
    ),
    body := '{}'::jsonb
  );
$$);
