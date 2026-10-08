-- Admin switch (Features → Multichain): "Unified merchant Ledger".
--   off (default) = current per-chain Ledger (chain list, single-chain claims)
--   on            = one Ledger balance for all chains, Claim All → Arc, no chain names
insert into public.app_settings (feature, enabled, category, label)
values ('merchant_unified_ledger', false, 'multichain', 'Unified merchant Ledger (one balance, no chain list)')
on conflict (feature) do nothing;
