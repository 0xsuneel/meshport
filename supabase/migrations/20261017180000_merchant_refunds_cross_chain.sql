-- Refunds on the customer's own chain, and refunds of payments that came in
-- on another chain without an order (merchant_chain_receipts).
--
-- route 'contract': on Arc through MeshPortRefunds (one per payment, on-chain).
-- route 'cctp':     a CCTP burn on Arc from the merchant's wallet that Circle
--                   mints to the payer's address on refund_chain. One refund per
--                   payment / receipt is enforced by the unique keys here.
alter table public.merchant_refunds alter column payment_id drop not null;
alter table public.merchant_refunds alter column intent_id drop not null;
alter table public.merchant_refunds add column if not exists receipt_id uuid unique references public.merchant_chain_receipts(id) on delete cascade;
alter table public.merchant_refunds add column if not exists refund_chain text not null default 'Arc_Testnet';
alter table public.merchant_refunds add column if not exists route text not null default 'contract' check (route in ('contract', 'cctp'));
alter table public.merchant_refunds add constraint merchant_refunds_target check (payment_id is not null or receipt_id is not null);
