-- Quieter when idle (Free plan: 1 GB of logs a month, ~33 MB a day - every
-- Edge Function call writes request + function logs). Measured 26 Nov with
-- no open work: ~79 Edge calls an hour, ~90 MB of logs a day.
--
-- 1. "Busy" for the eight payment recovery / reconcile jobs meant ANY
--    transaction attempt updated in the last 26 hours - one finished payment
--    kept all eight at full speed (every 10-15 min) for a day. They repair
--    unfinished attempts, so busy is now: an attempt still open (created in
--    the last 2 days), or one that changed in the last 2 hours.
-- 2. The idle heartbeat (a run even when nothing is waiting, as a safety net)
--    goes from 30 minutes to 6 hours. Two stay at 30 minutes: the watchers
--    that catch money arriving - merchant-deposit-watch (business payments)
--    and chain-transfer-webhook-sweep (incoming deposits) - plus the Arc index
--    pass (blockchain-indexer-shadow), now gated the same way instead of
--    every 10 minutes (Alchemy's Arc webhook is the main path).
--    Any real work still runs at once and at full speed.
-- 3. news-sync every 2 hours (was 30 minutes).

create or replace function public.cron_should_run(p_job text)
returns boolean language plpgsql volatile security definer set search_path to 'public' as $function$
declare
  tx_busy boolean;
  busy    boolean;
  last    timestamptz;
  idle    interval;
begin
  tx_busy := exists (
    select 1 from transaction_attempts
    where updated_at > now() - interval '2 hours'
       or (status::text in ('CREATED', 'BROADCASTING', 'SUBMITTED', 'CONFIRMING', 'SUBMITTED_UNKNOWN')
           and created_at > now() - interval '2 days'));

  busy := case p_job
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
    when 'merchant-deposit-watch' then exists (
      select 1 from merchant_payment_intents
      where status::text in ('pending', 'partially_paid')
        and created_at > now() - interval '2 days'
        and (expires_at is null or expires_at > now() - interval '1 day'))
    when 'pay-nonce-recovery-sweep'      then tx_busy
    when 'swap-nonce-recovery-sweep'     then tx_busy
    when 'bulkpay-nonce-recovery-sweep'  then tx_busy
    when 'pay-reconcile-sweep'           then tx_busy
    when 'swap-reconcile-sweep'          then tx_busy
    when 'bulkpay-reconcile-sweep'       then tx_busy
    when 'swap-broadcast-recovery-sweep' then tx_busy
    when 'activity-ledger-link-sweep'    then tx_busy
    when 'chain-transfer-webhook-sweep' then exists (
      select 1 from activity
      where activity_type::text = 'receive' and status::text = 'completed'
        and metadata->>'receiveKind' = 'external_deposit'
        and metadata->>'pushed' is null
        and created_at > now() - interval '15 minutes')
    when 'name-register-sync' then exists (
      select 1 from users
      where name_onchain_status in ('pending', 'failed') and name_onchain_request is not null)
    when 'deposit-scan-all-reconcile' then false
    when 'blockchain-indexer-shadow'  then false
    else true
  end;

  if not busy then
    idle := case when p_job in ('merchant-deposit-watch', 'chain-transfer-webhook-sweep', 'blockchain-indexer-shadow')
                 then interval '30 minutes' else interval '6 hours' end;
    select r.last_run into last from cron_gate_runs r where r.jobname = p_job;
    if last is not null and last > now() - idle then
      return false;
    end if;
  end if;

  insert into cron_gate_runs (jobname, last_run) values (p_job, now())
  on conflict (jobname) do update set last_run = excluded.last_run;
  return true;
end
$function$;
revoke all on function public.cron_should_run(text) from public, anon, authenticated;

do $mig$
declare j record; body text;
begin
  -- Gate the Arc index pass (it ran every 10 minutes whatever happened).
  for j in select jobid, jobname, command, schedule from cron.job where jobname = 'blockchain-indexer-shadow' loop
    if j.command !~* '^\s*do \$gate\$' then
      insert into public.cron_job_originals (jobname, original_command, original_schedule)
      values (j.jobname, j.command, j.schedule) on conflict (jobname) do nothing;
      body := regexp_replace(regexp_replace(trim(j.command), '^\s*select\s+', '', 'i'), ';\s*$', '');
      perform cron.alter_job(j.jobid, command := format(
        'do $gate$ begin if public.cron_should_run(%L) then perform %s; end if; end $gate$;', j.jobname, body));
    end if;
  end loop;
  for j in select jobid, jobname, command, schedule from cron.job where jobname = 'news-sync' loop
    insert into public.cron_job_originals (jobname, original_command, original_schedule)
    values (j.jobname, j.command, j.schedule) on conflict (jobname) do nothing;
    perform cron.alter_job(j.jobid, schedule := '27 */2 * * *');
  end loop;
end $mig$;
