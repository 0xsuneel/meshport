-- Seeds the app_settings rows the Admin Panel's "UB (Circle Gateway)" and
-- "CCTP Override" sections (ChainsPage.tsx, categories `chains_ub` /
-- `chains_cctp`) read and write. The frontend resolution logic
-- (featureFilters.ts: resolveChainMechanism / resolveAvailableMechanisms)
-- and the Multichain Transfer route picker (MultichainTransferPage.tsx)
-- were already wired up to these feature keys, but no migration ever
-- created the underlying rows — so the Admin Panel showed "No settings
-- found" for both sections and there was nothing for the route picker to
-- read, no matter which toggle was flipped.
--
-- Only the 11 chains with a working UB (Circle Gateway) path get rows here
-- (CHAIN_UB_FEATURE_MAP / CHAIN_CCTP_OVERRIDE_FEATURE_MAP in
-- featureFilters.ts) — CCTP-only chains have no UB path to override.
--
-- Defaults reproduce exactly what's hardcoded today (UB on, CCTP off) so
-- nothing changes in production until an admin flips a toggle.
INSERT INTO public.app_settings (feature, enabled, category, label) VALUES
  ('ethereum_ub_enabled',     true,  'chains_ub',   'Ethereum'),
  ('base_ub_enabled',         true,  'chains_ub',   'Base'),
  ('arbitrum_ub_enabled',     true,  'chains_ub',   'Arbitrum'),
  ('polygon_ub_enabled',      true,  'chains_ub',   'Polygon'),
  ('optimism_ub_enabled',     true,  'chains_ub',   'Optimism'),
  ('avalanche_ub_enabled',    true,  'chains_ub',   'Avalanche'),
  ('hyperevm_ub_enabled',     true,  'chains_ub',   'HyperEVM'),
  ('sei_ub_enabled',          true,  'chains_ub',   'Sei'),
  ('sonic_ub_enabled',        true,  'chains_ub',   'Sonic'),
  ('unichain_ub_enabled',     true,  'chains_ub',   'Unichain'),
  ('world_chain_ub_enabled',  true,  'chains_ub',   'World Chain'),

  ('ethereum_cctp_enabled',    false, 'chains_cctp', 'Ethereum'),
  ('base_cctp_enabled',        false, 'chains_cctp', 'Base'),
  ('arbitrum_cctp_enabled',    false, 'chains_cctp', 'Arbitrum'),
  ('polygon_cctp_enabled',     false, 'chains_cctp', 'Polygon'),
  ('optimism_cctp_enabled',    false, 'chains_cctp', 'Optimism'),
  ('avalanche_cctp_enabled',   false, 'chains_cctp', 'Avalanche'),
  ('hyperevm_cctp_enabled',    false, 'chains_cctp', 'HyperEVM'),
  ('sei_cctp_enabled',         false, 'chains_cctp', 'Sei'),
  ('sonic_cctp_enabled',       false, 'chains_cctp', 'Sonic'),
  ('unichain_cctp_enabled',    false, 'chains_cctp', 'Unichain'),
  ('world_chain_cctp_enabled', false, 'chains_cctp', 'World Chain')
ON CONFLICT (feature) DO NOTHING;
