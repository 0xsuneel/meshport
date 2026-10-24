-- MPC wallet (testnet): MeshPort's share of each user's 2-of-3 wallet key,
-- and a log of every hash MeshPort agreed to co-sign. See docs/MPC_WALLET.md.
--
-- Only the wallet-mpc Edge Function (service role) touches these tables: RLS
-- is on and forced with no policies, and anon / authenticated get nothing.
-- share_ct is sealed by the function (AES-256-GCM, key derived from the
-- MPC_SECRET function secret, bound to the user and the address), so a dump
-- of this table alone opens nothing - and a share alone can't sign anyway.

create table if not exists public.wallet_mpc_shares (
  id          bigint generated always as identity primary key,
  auth_uid    uuid        not null references auth.users (id) on delete cascade,
  address     text        not null check (address ~ '^0x[0-9a-f]{40}$'),
  share_ct    text        not null,
  created_at  timestamptz not null default now(),
  -- Set when a share is replaced (refresh after a lost device) or removed.
  revoked_at  timestamptz
);

-- One live wallet per account, and one account per wallet address.
create unique index if not exists wallet_mpc_shares_active_uid_idx
  on public.wallet_mpc_shares (auth_uid) where revoked_at is null;
create unique index if not exists wallet_mpc_shares_active_address_idx
  on public.wallet_mpc_shares (address) where revoked_at is null;
-- Covers the auth.users cascade for revoked rows too.
create index if not exists wallet_mpc_shares_auth_uid_idx
  on public.wallet_mpc_shares (auth_uid);

alter table public.wallet_mpc_shares enable row level security;
alter table public.wallet_mpc_shares force row level security;
revoke all on public.wallet_mpc_shares from anon, authenticated;

create table if not exists public.wallet_mpc_sign_log (
  id          bigint generated always as identity primary key,
  auth_uid    uuid        not null references auth.users (id) on delete cascade,
  address     text        not null,
  sign_id     text        not null unique,
  hash        text        not null check (hash ~ '^0x[0-9a-f]{64}$'),
  -- 'tx' | 'message' | 'typed'
  kind        text        not null,
  -- What was signed, as the function read it (e.g. chain, to, value).
  summary     jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists wallet_mpc_sign_log_uid_created_idx
  on public.wallet_mpc_sign_log (auth_uid, created_at desc);

alter table public.wallet_mpc_sign_log enable row level security;
alter table public.wallet_mpc_sign_log force row level security;
revoke all on public.wallet_mpc_sign_log from anon, authenticated;
