-- Late payments, incoming-payment screening and overpayments (data contract
-- the Business UI reads).
--   merchant_payments.late            paid after the order expired, or onto a cancelled/expired order
--   merchant_payments.screen_flag     'usdc_blocklisted' when the sender is on USDC's blocklist
--   merchant_payment_intents.overpaid_amount  received - requested when > 0 (merchant_intent_recompute)
--   merchant_chain_receipts.screen_flag       same as merchant_payments.screen_flag
alter table public.merchant_payments
  add column if not exists late boolean not null default false,
  add column if not exists screen_flag text null;
alter table public.merchant_payment_intents
  add column if not exists overpaid_amount numeric not null default 0,
  add column if not exists opened_by uuid null;
alter table public.merchant_chain_receipts
  add column if not exists screen_flag text null;
alter table public.merchant_payments drop constraint if exists merchant_payments_screen_flag_check;
alter table public.merchant_payments add constraint merchant_payments_screen_flag_check
  check (screen_flag is null or screen_flag in ('usdc_blocklisted'));
alter table public.merchant_chain_receipts drop constraint if exists merchant_chain_receipts_screen_flag_check;
alter table public.merchant_chain_receipts add constraint merchant_chain_receipts_screen_flag_check
  check (screen_flag is null or screen_flag in ('usdc_blocklisted'));
