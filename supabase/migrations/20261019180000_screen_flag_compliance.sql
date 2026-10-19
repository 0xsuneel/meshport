-- Compliance screening flags beyond USDC's own on-chain blocklist.
--
-- screenSender() in the merchant-pay edge function now also calls Circle's
-- Compliance Engine (address screening) in parallel with the on-chain
-- FiatToken isBlacklisted() check. A DENIED result maps to one of three new
-- flags by risk category, so merchant_payments.screen_flag and
-- merchant_chain_receipts.screen_flag must accept them:
--
--   'usdc_blocklisted'  on USDC's own on-chain blocklist (unchanged)
--   'sanctions'         Circle: SANCTIONS / TERRORIST_FINANCING
--   'frozen'            Circle: FROZEN wallet
--   'high_risk'         Circle: DENIED for any other risk category
--
-- The frontend already treats any non-null screen_flag as "blocked" (truthy),
-- so these widen the allowed set without needing a frontend data change.
-- Additive only: existing rows and the 'usdc_blocklisted' value are untouched.

alter table public.merchant_payments drop constraint if exists merchant_payments_screen_flag_check;
alter table public.merchant_payments add constraint merchant_payments_screen_flag_check
  check (screen_flag is null or screen_flag in ('usdc_blocklisted', 'sanctions', 'frozen', 'high_risk'));

alter table public.merchant_chain_receipts drop constraint if exists merchant_chain_receipts_screen_flag_check;
alter table public.merchant_chain_receipts add constraint merchant_chain_receipts_screen_flag_check
  check (screen_flag is null or screen_flag in ('usdc_blocklisted', 'sanctions', 'frozen', 'high_risk'));
