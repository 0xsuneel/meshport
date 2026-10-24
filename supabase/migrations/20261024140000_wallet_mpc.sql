-- MPC wallet (testnet): MeshPort's share of each user's 2-of-3 wallet key,
-- and a log of every hash MeshPort agreed to co-sign. See docs/MPC_WALLET.md.
--
-- Only the signing service, api/wallet-mpc.ts (service role), touches these tables: RLS
-- is on and forced with no policies, and anon / authenticated get nothing.
-- share_ct is sealed by that service (AES-256-GCM, key derived from its
-- MPC_SECRET environment secret, bound to the user and the address), so a dump
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

-- Each step of each MPC session is accepted once. The signing service keeps
-- no memory between requests (its round state travels sealed with the
-- client), so this is what stops the same state being sent twice: re-running
-- an MPC round from one state ("rewinding") can leak the server's share.
-- Rows are only useful while a session is live (5 minutes); old ones can go.
create table if not exists public.wallet_mpc_steps (
  session_id  text        not null,
  step        integer     not null,
  created_at  timestamptz not null default now(),
  primary key (session_id, step)
);

create index if not exists wallet_mpc_steps_created_idx
  on public.wallet_mpc_steps (created_at);

alter table public.wallet_mpc_steps enable row level security;
alter table public.wallet_mpc_steps force row level security;
revoke all on public.wallet_mpc_steps from anon, authenticated;

-- The identity sequences get Supabase's default grants; their values would
-- tell anyone how many MPC wallets and signatures exist.
revoke all on sequence public.wallet_mpc_shares_id_seq from anon, authenticated;
revoke all on sequence public.wallet_mpc_sign_log_id_seq from anon, authenticated;
