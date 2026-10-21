-- merchant-deposit-watch: once a minute instead of every 15 seconds.
-- merchant-pay's 'watch' now keeps watching for ~55s per call in the
-- background (busy chains every 4s, the rest ~20s), holding
-- merchant_watch_lock for the loop - the way wallet backends watch for
-- incoming transfers. A quarter of the function calls, and payments are
-- recorded seconds after their block instead of up to 15s later.
select cron.alter_job(
  job_id   := (select jobid from cron.job where jobname = 'merchant-deposit-watch'),
  schedule := '* * * * *'
)
where exists (select 1 from cron.job where jobname = 'merchant-deposit-watch');
