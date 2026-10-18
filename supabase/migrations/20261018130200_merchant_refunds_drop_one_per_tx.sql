-- Replaced by merchant_refunds_cap (several refunds per payment). DROP TRIGGER
-- on this table hangs on the live project, so the old one-per-transfer
-- trigger is made a no-op and disabled instead (drop it later when the table
-- is quiet: drop trigger merchant_refunds_one_per_tx; drop function
-- merchant_refunds_one_per_tx()).
create or replace function public.merchant_refunds_one_per_tx()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  return new;
end $$;
alter table public.merchant_refunds disable trigger merchant_refunds_one_per_tx;
