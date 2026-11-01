-- wallet_events: what the wallet itself did on a device - opening, signing -
-- for Google / email (Circle) and private-key (frame) wallets alike. Written by the app (lib/walletEvents.ts),
-- one row per event, like move_timings. Only timings and outcomes: no keys,
-- signatures, messages or amounts.
create table if not exists public.wallet_events (
  id             uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  wallet_kind    text not null,
  event          text not null,
  ok             boolean not null,
  ms             integer,
  steps          jsonb,
  error          text,
  detail         text,
  path           text,
  online         boolean,
  network        text,
  visible        boolean,
  app_version    text,
  created_at     timestamptz not null default now()
);

create index if not exists wallet_events_created_idx on public.wallet_events (created_at desc);
create index if not exists wallet_events_wallet_idx on public.wallet_events (wallet_address, created_at desc);
create index if not exists wallet_events_kind_event_idx on public.wallet_events (wallet_kind, event, created_at desc);

alter table public.wallet_events enable row level security;

-- Same ownership rule as move_timings: a session writes and reads only its own wallet's rows.
drop policy if exists wallet_events_insert on public.wallet_events;
create policy wallet_events_insert on public.wallet_events
  for insert with check (session_may_use_wallet(wallet_address));
drop policy if exists wallet_events_select on public.wallet_events;
create policy wallet_events_select on public.wallet_events
  for select using (session_may_use_wallet(wallet_address));
