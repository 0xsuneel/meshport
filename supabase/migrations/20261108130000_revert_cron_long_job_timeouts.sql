-- Revert 20261108120000_cron_long_job_timeouts.
--
-- pg_net 0.20.x sends the queued requests as one batch and does not start the
-- next batch until every request in it has finished or timed out. With a 70 s
-- timeout on the 58 s chain-transfer-webhook sweep, every other cron request
-- (pay/swap confirm, p2p release, keep-api-warm, ...) waited about a minute
-- behind it (seen 8 Nov 01:29-01:31). The 5 s default keeps batches short;
-- the edge functions still run to completion after pg_net stops waiting, so
-- those timeouts are noise, not failures.
--
-- A real fix is for the long sweeps to answer at once and keep working in the
-- background (EdgeRuntime.waitUntil), not to make pg_net wait.

select cron.schedule('chain-transfer-webhook-sweep', '* * * * *', $$
  select net.http_post(
    url     := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/chain-transfer-webhook',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'claim_worker_service_key')
    ),
    body    := jsonb_build_object('mode', 'sweep')
  );
$$);

select cron.schedule('blockchain-indexer-shadow', '* * * * *', $$
  select net.http_post(
    url     := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/blockchain-indexer',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'claim_worker_service_key')
    ),
    body    := jsonb_build_object('mode', 'index')
  );
$$);
