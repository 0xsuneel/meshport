-- Run the chain indexer every minute instead of every 2 minutes.
--
-- Its pass is now short (external chains read token logs only and are
-- scanned side by side - see blockchain-indexer/scanner.ts and index.ts), so
-- a deposit on any chain produces its chain_event, and the instant balance
-- refresh in the app, within about a minute.
select cron.alter_job(jobid, schedule := '* * * * *')
from cron.job
where jobname = 'blockchain-indexer-shadow';
