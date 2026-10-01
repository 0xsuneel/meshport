-- ─────────────────────────────────────────────────────────────────────────
-- Relay funding audit log + rate-limit backing table.
--
-- Bug this closes: api/relay-gas.ts and api/relay-deposit.js (Vercel
-- serverless routes, not Supabase edge functions) had NO caller-identity
-- check at all — any request with a valid-looking address got the relay
-- wallet (RELAY_PRIVATE_KEY) to sign and send real gas / real depositFor
-- calls, with no rate limit and no cumulative cap. See /cso findings #1/#2.
--
-- This table is the persistent, cross-invocation counter both routes now
-- check before funding and write to after funding (service-role only, same
-- shape as wallet_audit_log). Rate-limit and daily-cap logic lives in the
-- route handlers; this table only stores the facts.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.relay_funding_log (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('gas', 'deposit')),
  auth_uid    uuid not null,
  address     text not null,
  chain_id    text not null,
  amount_wei  numeric,      -- relay-gas: wei of native token sent (null for 'deposit')
  amount_usdc numeric,      -- relay-deposit: USDC amount (null for 'gas')
  created_at  timestamptz not null default now()
);

create index if not exists relay_funding_log_uid_kind_idx
  on public.relay_funding_log (auth_uid, kind, created_at desc);
create index if not exists relay_funding_log_addr_kind_idx
  on public.relay_funding_log (address, kind, created_at desc);
create index if not exists relay_funding_log_chain_kind_idx
  on public.relay_funding_log (chain_id, kind, created_at desc);

alter table public.relay_funding_log enable row level security;

-- No client ever reads or writes this directly — only the Vercel relay
-- routes, using the service role key, exactly like wallet_audit_log.
revoke all on public.relay_funding_log from anon, authenticated;
