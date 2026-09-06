-- ============================================================
-- MeshPort: external chain balance snapshots, for claim-attention-scan
--
-- WHY THIS EXISTS: "Available to claim" on the Multichain Hub only ever
-- scanned external chain balances client-side, while that page happened
-- to be open. If USDC landed on an external chain (e.g. Ethereum Sepolia)
-- while the app was closed, nothing told the user — they'd only find out
-- whenever they next happened to open the Hub. That gap (hours, maybe
-- days) dwarfs every other latency this app has ever optimized for CCTP
-- attestation, which is only ever 20-90 seconds.
--
-- This table lets a background scan (claim-attention-scan) remember the
-- last-seen balance per (wallet, chain), so it can detect a genuine
-- INCREASE — new funds that weren't there last sweep — and fire a push
-- notification, rather than re-notifying for the same static balance on
-- every pass or missing the fact that funds arrived at all.
-- ============================================================

create table if not exists external_balance_snapshots (
  wallet_address text not null,
  chain_id       text not null,  -- matches EXTERNAL_CHAINS keys in MultichainPage.tsx, e.g. 'Ethereum_Sepolia'
  balance        numeric not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (wallet_address, chain_id)
);

create index if not exists idx_external_balance_snapshots_wallet
  on external_balance_snapshots (wallet_address);

-- RLS: service-role only (this table is written exclusively by the
-- claim-attention-scan edge function using the service key, and isn't
-- meant to be queried directly by any client).
alter table external_balance_snapshots enable row level security;
