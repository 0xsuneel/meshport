-- Phase 1 last cuts (docs/SUPABASE_LIGHT_PLAN.md):
--   keep-api-warm  paused: a pay-intent ping every 5 min (12 calls/hour) only
--                  spared the first payment after a quiet spell ~1 s of cold
--                  start.
--   indexer-fast   the 17 chains Alchemy does not push (1 event in 30 days):
--   (+ rest)       one pass every 30 min instead of 10. A pass reads up to
--                  ~40k blocks, so 30 min of the fastest chain still fits.
-- Undo: originals in public.cron_job_originals; keep-api-warm:
--   select cron.alter_job(jobid, active := true) from cron.job where jobname = 'keep-api-warm';

do $mig$
declare j record;
begin
  for j in select jobid, jobname, command, schedule from cron.job where jobname = 'keep-api-warm' loop
    insert into public.cron_job_originals (jobname, original_command, original_schedule)
    values (j.jobname, j.command, j.schedule) on conflict (jobname) do nothing;
    perform cron.alter_job(j.jobid, active := false);
  end loop;

  for j in select jobid, jobname, command, schedule from cron.job where jobname in ('indexer-fast', 'indexer-fast-rest') loop
    insert into public.cron_job_originals (jobname, original_command, original_schedule)
    values (j.jobname, j.command, j.schedule) on conflict (jobname) do nothing;
    perform cron.alter_job(j.jobid, schedule := case j.jobname when 'indexer-fast' then '4-59/30 * * * *' else '19-59/30 * * * *' end);
  end loop;
end $mig$;
