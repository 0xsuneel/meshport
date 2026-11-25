-- Sweeps call their Edge Function only when the database shows work for it.
--
-- ~15k Edge Function calls a day came from cron sweeps that ran every 1-3
-- minutes whether or not anything was pending (the free plan allows 500k a
-- month, and each call's own database reads add egress and log volume).
-- Each gated job now runs when its condition holds, and otherwise still once
-- or twice every 10 minutes (minute ending in 0 or 1) so nothing can get
-- stuck because a condition missed a case - the same self-healing net as
-- before, just slower when idle.
--
-- Original commands are kept in cron_job_originals; to undo one:
--   select cron.alter_job(jobid, command := original_command)
--   from cron_job_originals where jobname = '<name>';

create table if not exists public.cron_job_originals (
  jobname text primary key,
  original_command text not null,
  original_schedule text not null,
  saved_at timestamptz not null default now()
);
alter table public.cron_job_originals enable row level security;
revoke all on public.cron_job_originals from anon, authenticated;

create or replace function public.cron_should_run(p_job text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    -- Self-healing fallback: every job still runs at least every 10 minutes.
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
      else true
    end
$$;
revoke all on function public.cron_should_run(text) from public, anon, authenticated;

do $mig$
declare
  j record;
  body text;
begin
  for j in
    select jobid, jobname, command, schedule from cron.job
    where jobname in ('ub-claim-worker-sweep', 'p2p-release-reconcile-sweep', 'transfer-worker-sweep',
                      'claim-worker-sweep', 'pay-confirm-sweep', 'bulkpay-confirm-sweep',
                      'swap-confirm-sweep', 'activity-consumer-sweep', 'ledger-interpret-sweep')
  loop
    if j.command ~* '^\s*do \$gate\$' then continue; end if;   -- already gated
    insert into public.cron_job_originals (jobname, original_command, original_schedule)
    values (j.jobname, j.command, j.schedule)
    on conflict (jobname) do nothing;
    body := regexp_replace(regexp_replace(trim(j.command), '^\s*select\s+', '', 'i'), ';\s*$', '');
    perform cron.alter_job(j.jobid, command := format(
      'do $gate$ begin if public.cron_should_run(%L) then perform %s; end if; end $gate$;',
      j.jobname, body));
  end loop;

  -- keep-api-warm: every 5 minutes instead of every minute (1,440 pay-intent
  -- pings a day). A cold start costs the first payment after a quiet spell
  -- about a second; it no longer costs ~43k Edge Function calls a month.
  for j in select jobid, jobname, command, schedule from cron.job where jobname = 'keep-api-warm' loop
    insert into public.cron_job_originals (jobname, original_command, original_schedule)
    values (j.jobname, j.command, j.schedule)
    on conflict (jobname) do nothing;
    perform cron.alter_job(j.jobid, schedule := '*/5 * * * *');
  end loop;
end $mig$;

-- blockchain-indexer's 'index' pass: every 5 minutes instead of every minute.
-- indexer-fast already reads every external chain every 4 s and
-- chain-transfer-webhook watches Arc every 2 s; this pass is their safety net.
do $m$
declare j record;
begin
  for j in select jobid, jobname, command, schedule from cron.job where jobname = 'blockchain-indexer-shadow' loop
    insert into public.cron_job_originals (jobname, original_command, original_schedule)
    values (j.jobname, j.command, j.schedule) on conflict (jobname) do nothing;
    perform cron.alter_job(j.jobid, schedule := '2-59/5 * * * *');
  end loop;
end $m$;
