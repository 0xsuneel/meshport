-- Solana (docs/SOLANA.md) gets the same four Admin Panel switches every
-- other chain has, all ON - the way the live Unified Balance chains are set
-- (both routes on, so Transfer shows the Unified Balance | CCTP picker):
--   solana_transfer_enabled  (chains_transfer)  CHAIN_TRANSFER_FEATURE_MAP.sol
--   solana_claim_enabled     (chains_claim)     CHAIN_CLAIM_FEATURE_MAP.Solana_Devnet
--   solana_ub_enabled        (chains_ub)        CHAIN_UB_FEATURE_MAP.sol
--   solana_cctp_enabled      (chains_cctp)      CHAIN_CCTP_OVERRIDE_FEATURE_MAP.sol
-- Until these rows exist the app already treats all four as ON
-- (featureFilters.ts: missing rows default on; CCTP_DEFAULT_ON has 'sol').
-- Insert-only; existing rows are left as they are.
INSERT INTO public.app_settings (feature, enabled, category, label) VALUES
  ('solana_transfer_enabled', true, 'chains_transfer', 'Solana (Transfer)'),
  ('solana_claim_enabled',    true, 'chains_claim',    'Solana (Claim)'),
  ('solana_ub_enabled',       true, 'chains_ub',       'Solana (UB)'),
  ('solana_cctp_enabled',     true, 'chains_cctp',     'Solana (CCTP)')
ON CONFLICT (feature) DO NOTHING;
