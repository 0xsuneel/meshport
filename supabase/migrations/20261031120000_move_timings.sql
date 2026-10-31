-- Step timings for Transfer, Bring and Swap (lib/moveTimings.ts): how long
-- each step of one move took on the device - passcode, wallet open, quote,
-- signature, send, attestation, mint / arrival - so a slow move shows which
-- step was slow. Written once by the app at the end of a move; read by
-- admins (service key) when looking into speed. No amounts beyond the move's
-- own, no keys or signatures.
create table if not exists public.move_timings (
  id             uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  kind           text not null check (kind in ('transfer', 'bring', 'swap')),
  route          text,
  chain          text,
  token          text,
  tx_hash        text,
  ok             boolean not null,
  error          text,
  total_ms       integer not null,
  steps          jsonb not null,
  app_version    text,
  created_at     timestamptz not null default now()
);

create index if not exists move_timings_created_idx on public.move_timings (created_at desc);
create index if not exists move_timings_wallet_idx on public.move_timings (wallet_address, created_at desc);

alter table public.move_timings enable row level security;

-- Same ownership rule as activity: a session writes and reads only its own wallet's rows.
drop policy if exists move_timings_insert on public.move_timings;
create policy move_timings_insert on public.move_timings
  for insert with check (session_may_use_wallet(wallet_address));
drop policy if exists move_timings_select on public.move_timings;
create policy move_timings_select on public.move_timings
  for select using (session_may_use_wallet(wallet_address));
