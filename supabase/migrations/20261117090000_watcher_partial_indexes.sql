-- The deposit watcher's two list reads (merchant-pay readOpenOrders /
-- readMerchantWallets), from an index instead of a scan of the whole table
-- (17 Nov 2026: both tables were read by sequential scan ~150k times; small
-- today, but each scan grows with every order and every account).
-- Partial, so they cover only the rows the watcher wants and cost almost
-- nothing to keep up on insert.
create index if not exists merchant_payment_intents_watch_open
  on public.merchant_payment_intents (created_at)
  where status in ('pending', 'partially_paid', 'expired', 'cancelled');

create index if not exists users_business_wallet
  on public.users (wallet_address)
  where account_type = 'business' and wallet_address is not null;
