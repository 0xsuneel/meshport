-- P2P: repair a release stranded by a closed app within ~3 minutes, not ~8+.
--
-- p2p-release-reconcile ran every 10 minutes and waited 5 minutes from trade
-- creation, so a seller whose app closed mid-release left the buyer waiting
-- up to the next 10-minute tick (trade bd8b1945: claimed 00:42, restored
-- 00:50). It now waits 2 minutes from the release claim and runs every
-- minute. The function only reads the escrow contract and fixes the trade
-- row; it never sends a transaction.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'p2p-release-reconcile-sweep'),
  schedule := '* * * * *'
);
