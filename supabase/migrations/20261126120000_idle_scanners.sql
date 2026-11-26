-- Idle scanners stop costing Edge Function calls (26 Nov 2026).
--
-- Measured over an hour with 17 users: ~370 Edge calls/hour, ~250 of them
-- fixed polling that runs whether anyone uses the app or not.
--
--   merchant-deposit-watch  every minute (4 s loop) with zero open orders
--                           (last order 7 days ago). Now every minute only
--                           while an order can still be paid, otherwise the
--                           10-minute heartbeat of cron_should_run.
--   indexer-fast (+ rest)   chains NOT pushed by Alchemy webhooks: 17 chains,
--                           ONE event between them in 30 days, read every 4 s
--                           around the clock (120 calls/hour). Now one pass
--                           every 10 minutes each. The app reads these
--                           balances itself (/api/portfolio on open and every
--                           30 s while visible), as MetaMask does; this only
--                           backs the "money arrived" push while it is closed.
--
-- Undo: original commands/schedules are in public.cron_job_originals.

create or replace function public.cron_should_run(p_job text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    extract(minute from now())::int % 10 in (0, 1)
    or case p_job
      when 'ub-claim-worker-sweep' then exists (
        select 1 from ub_claim_intents where status::text in ('waiting', 'submitted'))
      when 'p2p-release-reconcile-sweep' then exists (
        select 1 from p2p_trades where status::text = 'released' and released_at is null)
      when 'transfer-worker-sweep' then exists (
        select 1 from activity where activity_type::text = 'bridge' and status::text = 'pending')
      when 'claim-worker-sweep' then exists (
        select 1 from claims where status::text not in ('completed', 'failed', 'cancelled', 'expired'))
      when 'pay-confirm-sweep' then exists (
        select 1 from transaction_attempts
        where status::text in ('SUBMITTED', 'CONFIRMING', 'SUBMITTED_UNKNOWN') and created_at > now() - interval '6 hours')
      when 'bulkpay-confirm-sweep' then exists (
        select 1 from transaction_attempts
        where status::text in ('SUBMITTED', 'CONFIRMING', 'SUBMITTED_UNKNOWN') and created_at > now() - interval '6 hours')
      when 'swap-confirm-sweep' then exists (
        select 1 from transaction_attempts
        where status::text in ('SUBMITTED', 'CONFIRMING', 'SUBMITTED_UNKNOWN') and created_at > now() - interval '6 hours')
      when 'activity-consumer-sweep' then exists (
        select 1 from chain_events
        where created_at > now() - interval '15 minutes' or confirmed_at > now() - interval '15 minutes')
      when 'ledger-interpret-sweep' then exists (
          select 1 from chain_events where confirmed_at > now() - interval '15 minutes')
        or exists (
          select 1 from transaction_attempts where updated_at > now() - interval '15 minutes')
      -- An order that can still be paid: open, or created in the last 2 days
      -- and expired/cancelled within the late-payment day.
      when 'merchant-deposit-watch' then exists (
        select 1 from merchant_payment_intents
        where status::text in ('pending', 'partially_paid')
          and created_at > now() - interval '2 days'
          and (expires_at is null or expires_at > now() - interval '1 day'))
      else true
    end
$function$;

do $mig$
declare j record; body text;
begin
  for j in select jobid, jobname, command, schedule from cron.job where jobname = 'merchant-deposit-watch' loop
    if j.command ~* '^\s*do \$gate\$' then continue; end if;
    insert into public.cron_job_originals (jobname, original_command, original_schedule)
    values (j.jobname, j.command, j.schedule) on conflict (jobname) do nothing;
    body := regexp_replace(regexp_replace(trim(j.command), '^\s*select\s+', '', 'i'), ';\s*$', '');
    perform cron.alter_job(j.jobid, command := format(
      'do $gate$ begin if public.cron_should_run(%L) then perform %s; end if; end $gate$;',
      j.jobname, body));
  end loop;

  for j in select jobid, jobname, command, schedule from cron.job where jobname in ('indexer-fast', 'indexer-fast-rest') loop
    insert into public.cron_job_originals (jobname, original_command, original_schedule)
    values (j.jobname, j.command, j.schedule) on conflict (jobname) do nothing;
    perform cron.alter_job(j.jobid, schedule := case j.jobname when 'indexer-fast' then '4-59/10 * * * *' else '9-59/10 * * * *' end);
  end loop;
end $mig$;
