-- Circle user-controlled wallets: which Circle user (and Arc wallet) belongs
-- to which MeshPort account. One Circle user per account and one account per
-- Circle user. Holds no keys or tokens - Circle keeps the key shares; a
-- user's Circle session token stays in their browser.
--
-- Only the backend (api/circle-wallet.ts, service role) touches this table:
-- RLS is on and forced with no policies, and anon / authenticated get nothing.

create table if not exists public.circle_wallet_users (
  auth_uid        uuid        primary key references auth.users (id) on delete cascade,
  circle_user_id  text        not null unique,
  wallet_id       uuid,
  address         text        check (address is null or address ~ '^0x[0-9a-fA-F]{40}$'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.circle_wallet_users enable row level security;
alter table public.circle_wallet_users force row level security;
revoke all on public.circle_wallet_users from anon, authenticated;
