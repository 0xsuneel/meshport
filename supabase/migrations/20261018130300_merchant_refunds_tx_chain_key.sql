-- One row per refund transaction (idempotency), per chain it was sent on.
create unique index if not exists merchant_refunds_tx_chain_key on public.merchant_refunds (tx_hash, refund_chain);
create index if not exists merchant_refunds_payment_idx on public.merchant_refunds (payment_id) where payment_id is not null;
create index if not exists merchant_refunds_receipt_idx on public.merchant_refunds (receipt_id) where receipt_id is not null;
