-- One transaction can pay two merchants: the tx keys include the merchant's wallet.
create unique index if not exists merchant_payments_chain_tx_wallet_key
  on public.merchant_payments (source_chain, tx_hash, merchant_wallet);
create unique index if not exists merchant_unmatched_deposits_chain_tx_wallet_key
  on public.merchant_unmatched_deposits (source_chain, tx_hash, merchant_wallet);
