-- Gasless bridge relayer (api/bridge-relay) uses relay_funding_log for its
-- abuse limits, the same way relay-gas / relay-deposit do:
--   kind = 'bridge', amount_usdc = USDC bridged, amount_wei = gas the relayer
--   spent, tx_hash = the router transaction.
-- Additive only: existing rows and the other routes are unaffected.
alter table public.relay_funding_log drop constraint if exists relay_funding_log_kind_check;
alter table public.relay_funding_log
  add constraint relay_funding_log_kind_check check (kind in ('gas', 'deposit', 'bridge'));
alter table public.relay_funding_log add column if not exists tx_hash text;
