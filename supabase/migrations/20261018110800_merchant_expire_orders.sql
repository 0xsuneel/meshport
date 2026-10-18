-- Pending orders past their expiry are marked expired (every 5 minutes), so
-- stale rows stop counting as open. A payment that still arrives within a day
-- is recorded with late = true and moves the order to paid / partially paid.
create or replace function public.merchant_expire_orders()
returns integer language sql security definer set search_path = '' as $$
  with x as (
    update public.merchant_payment_intents set status = 'expired'
     where status = 'pending' and expires_at is not null and expires_at < now() and received_amount = 0
    returning 1)
  select count(*)::int from x
$$;
revoke execute on function public.merchant_expire_orders() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'merchant-expire-orders';
select cron.schedule('merchant-expire-orders', '*/5 * * * *', 'select public.merchant_expire_orders()');
