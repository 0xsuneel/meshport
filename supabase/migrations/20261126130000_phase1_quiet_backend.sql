-- Phase 1 of docs/SUPABASE_LIGHT_PLAN.md: background load close to zero.
--
-- 1. Idle heartbeat: every 30 minutes per job (was: minutes 0-1 of every 10,
--    which jobs scheduled on other minutes - 3-59/10, 2-59/15 ... - could
--    never hit). cron_gate_runs remembers each job's last run.
-- 2. Jobs that ran on a timer with nothing to do are now gated:
--      nonce recovery x3, reconcile x3, swap broadcast recovery,
--      activity-ledger link   -> only while a transaction attempt changed in
--                                the last 26 h or one is still in flight
--                                (none since 23 Nov; they ran every 10-15 min)
--      chain-transfer-webhook -> only while a deposit waits for its push
--                                (its 58 s Arc watcher mostly timed out under
--                                pg_net; Alchemy pushes Arc transfers now)
--      deposit-scan-all       -> heartbeat only (4th Arc backstop scan)
--      name-register-sync     -> only while a name waits to be registered
-- 3. blockchain-indexer 'index' (the Arc safety-net pass) every 10 min, was 5.
-- 4. blockchain-indexer-compare (hourly shadow-vs-live diagnostic) paused.
--
-- Undo: original commands/schedules are in public.cron_job_originals;
-- compare: select cron.alter_job(jobid, active := true) ... .

create table if not exists public.cron_gate_runs (
  jobname  text primary key,
  last_run timestamptz not null
);
alter table public.cron_gate_runs enable row level security;
revoke all on public.cron_gate_runs from anon, authenticated;

create or replace function public.cron_should_run(p_job text)
returns boolean
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  tx_busy boolean;
  busy    boolean;
  last    timestamptz;
begin
  tx_busy := exists (
    select 1 from transaction_attempts
    where updated_at > now() - interval '26 hours'
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
    else true
  end;

  if not busy then
    select r.last_run into last from cron_gate_runs r where r.jobname = p_job;
    if last is not null and last > now() - interval '30 minutes' then
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
  for j in
    select jobid, jobname, command, schedule from cron.job
    where jobname in ('pay-nonce-recovery-sweep', 'swap-nonce-recovery-sweep', 'bulkpay-nonce-recovery-sweep',
                      'pay-reconcile-sweep', 'swap-reconcile-sweep', 'bulkpay-reconcile-sweep',
                      'swap-broadcast-recovery-sweep', 'activity-ledger-link-sweep',
                      'chain-transfer-webhook-sweep', 'name-register-sync', 'deposit-scan-all-reconcile')
  loop
    if j.command ~* '^\s*do \$gate\$' then continue; end if;   -- already gated
    insert into public.cron_job_originals (jobname, original_command, original_schedule)
    values (j.jobname, j.command, j.schedule) on conflict (jobname) do nothing;
    body := regexp_replace(regexp_replace(trim(j.command), '^\s*select\s+', '', 'i'), ';\s*$', '');
    perform cron.alter_job(j.jobid, command := format(
      'do $gate$ begin if public.cron_should_run(%L) then perform %s; end if; end $gate$;',
      j.jobname, body));
  end loop;

  for j in select jobid, jobname, command, schedule from cron.job where jobname = 'blockchain-indexer-shadow' loop
    insert into public.cron_job_originals (jobname, original_command, original_schedule)
    values (j.jobname, j.command, j.schedule) on conflict (jobname) do nothing;
    perform cron.alter_job(j.jobid, schedule := '2-59/10 * * * *');
  end loop;

  for j in select jobid from cron.job where jobname = 'blockchain-indexer-compare' loop
    perform cron.alter_job(j.jobid, active := false);
  end loop;
end $mig$;
