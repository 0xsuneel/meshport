-- Keep one hour of pg_cron run history instead of a day.
--
-- ~25 jobs run every minute, each adding a cron.job_run_details row, so a
-- day of history is ~36,000 rows constantly inserted and deleted. On the Nano
-- instance that churn added to the disk IO that ran out on 14 Nov 2026. An
-- hour (~1,500 rows) is plenty to see why a job failed; nothing in the app
-- reads this table.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'purge-cron-history'),
  command := $$delete from cron.job_run_details where end_time < now() - interval '1 hour'$$
);
