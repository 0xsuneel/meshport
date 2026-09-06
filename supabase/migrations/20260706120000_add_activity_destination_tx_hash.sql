-- Previously `activity` only had a single `tx_hash` column. For transfers
-- (Arc -> external chain), this meant only ONE side of the transaction could
-- ever be recorded — MultichainSendPage.tsx actually captures BOTH a burn-step
-- hash (Arc/source side) and a mint-step hash (destination-chain side)
-- internally already, but only ever saved one. Claims already have this
-- (tx_hash = source burn, destination_tx_hash = Arc mint) — this brings
-- `activity` to parity so transfer history can show both sides too.
alter table public.activity
  add column if not exists destination_tx_hash text;

comment on column public.activity.tx_hash is
  'For claims: source-chain burn hash. For transfers: Arc-side departure (burn) hash.';
comment on column public.activity.destination_tx_hash is
  'For claims: Arc-side mint hash. For transfers: destination-chain arrival (mint) hash.';
