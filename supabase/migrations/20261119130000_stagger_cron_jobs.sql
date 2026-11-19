-- Spread the scheduled jobs across the hour (19 Nov 2026).
-- Every */2, */5, */10, */15 and */30 job used to start on the same minutes
-- (:00, :15, :30 and every even minute) as the nine every-minute jobs: up to
-- ~20 jobs at one instant. On this database that ran it out of connections
-- for 10-25 s ("cron job N job startup timeout"), and a payment arriving
-- then waited that long (pay-intent: 30 s). Each job keeps its exact
-- frequency; only the minute it starts on moves.
select cron.alter_job(19, schedule := '1-59/2 * * * *');   -- blockchain-indexer bulkpay-confirm (odd minutes)
select cron.alter_job(25, schedule := '1-59/2 * * * *');   -- blockchain-indexer swap-confirm (odd minutes)
select cron.alter_job(13, schedule := '1-59/10 * * * *');  -- deposit-scan-all reconcile
select cron.alter_job(20, schedule := '3-59/10 * * * *');  -- bulkpay-nonce-recovery
select cron.alter_job(23, schedule := '5-59/10 * * * *');  -- pay-nonce-recovery
select cron.alter_job(43, schedule := '6-59/10 * * * *');  -- name-register sync
select cron.alter_job(26, schedule := '8-59/10 * * * *');  -- swap-nonce-recovery
select cron.alter_job(21, schedule := '2-59/15 * * * *');  -- bulkpay-reconcile
select cron.alter_job(24, schedule := '4-59/15 * * * *');  -- pay-reconcile
select cron.alter_job(27, schedule := '7-59/15 * * * *');  -- swap-reconcile
select cron.alter_job(29, schedule := '9-59/15 * * * *');  -- swap-broadcast-recovery
select cron.alter_job(31, schedule := '11-59/15 * * * *'); -- activity-ledger-link
select cron.alter_job(42, schedule := '13-59/15 * * * *'); -- p2p_fx_refresh
select cron.alter_job(30, schedule := '14-59/30 * * * *'); -- attempt-reaper
select cron.alter_job(41, schedule := '27-59/30 * * * *'); -- news-sync
select cron.alter_job(46, schedule := '3-59/5 * * * *');   -- merchant_expire_orders
