-- Wallet sign-in (19 Nov 2026): each signed sign-in message carries a random
-- nonce; the wallet-login function records it here so a captured message can
-- never be used again. Server-only: RLS on, no policies (service role only).
create table if not exists public.wallet_login_nonces (
  nonce   text primary key,
  wallet  text not null,
  used_at timestamptz not null default now()
);
alter table public.wallet_login_nonces enable row level security;
revoke all on public.wallet_login_nonces from anon, authenticated;
create index if not exists wallet_login_nonces_used_at on public.wallet_login_nonces (used_at);
