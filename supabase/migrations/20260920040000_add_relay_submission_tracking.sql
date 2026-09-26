-- MeshPort: server-side CCTP relay submission for Multichain Claim
--
-- claim-worker previously only ever PASSIVELY scanned for a mint that
-- Circle's own automatic relayer (or someone else) would eventually submit.
-- This adds the ability for claim-worker to submit receiveMessage() itself
-- via a dedicated relayer wallet, so claim completion no longer depends on
-- Circle's relayer timing or on log-scanning RPC state.
--
-- This is additive only: existing passive detection (nonce match, amount
-- fallback) is completely unchanged and remains the actual source of truth
-- for completion — it will pick up the mint whether OUR relay submission
-- succeeded, or Circle's own relayer got there first. relay_tx_hash /
-- relay_error just record what claim-worker's own attempt did, for
-- diagnostics, and to ensure at most one attempt per claim.

alter table claims
  add column if not exists relay_tx_hash    text,
  add column if not exists relay_submitted_at timestamptz,
  add column if not exists relay_error      text;

comment on column claims.relay_tx_hash is
  'The tx hash claim-worker''s own relayer wallet used to submit receiveMessage() on Arc for this claim, if it did. Distinct from destination_tx_hash (the resulting mint tx, found by passive detection regardless of who relayed).';
comment on column claims.relay_error is
  'Non-fatal diagnostic for why claim-worker''s own relay attempt did not succeed (e.g. already relayed by someone else, insufficient relayer gas). Claim completion never depends on this being null - passive detection is still the source of truth.';

-- ── Atomic nonce allocation for the relayer wallet ───────────────────────
-- claim-worker processes multiple due claims concurrently (Promise.all in
-- processPass). Two claims needing a first-time relay submission in the
-- same pass must never get handed the same on-chain nonce (one would fail
-- or silently replace the other). This table + function give claim-worker
-- a single, Postgres-locked counter to allocate from instead of racing on
-- eth_getTransactionCount, which is only ever used once, to BOOTSTRAP the
-- counter to the real on-chain value the first time this relayer address
-- is ever used.
create table if not exists relayer_nonce (
  address    text primary key,
  next_nonce bigint not null,
  updated_at timestamptz not null default now()
);

create or replace function get_and_increment_relayer_nonce(p_address text, p_bootstrap_nonce bigint)
returns bigint
language plpgsql
as $$
declare
  v_nonce bigint;
begin
  insert into relayer_nonce (address, next_nonce)
  values (lower(p_address), p_bootstrap_nonce)
  on conflict (address) do nothing;

  update relayer_nonce
  set next_nonce = next_nonce + 1,
      updated_at = now()
  where address = lower(p_address)
  returning next_nonce - 1 into v_nonce;

  return v_nonce;
end;
$$;
