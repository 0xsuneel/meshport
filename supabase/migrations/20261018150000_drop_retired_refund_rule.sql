-- Run by hand in the SQL editor on 2026-10-18 (the old one-refund rule and
-- the retired staff_payments copy).
drop trigger if exists merchant_refunds_one_per_tx on public.merchant_refunds;
drop function if exists public.merchant_refunds_one_per_tx();
drop function if exists public.staff_payments_old(uuid, integer);
