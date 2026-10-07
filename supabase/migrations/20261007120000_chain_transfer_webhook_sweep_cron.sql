-- MeshPort: drive chain-transfer-webhook's catch-up push sweep from cron
--
-- The sweep (push notifications for external deposits recorded by
-- deposit-scan-all / activity-consumer / the app) used to run as a side
-- effect of every Circle webhook delivery. The USDC monitor delivers every
-- Transfer on Arc (~490k/day) and the function cold-starts on nearly every
-- call, so its 10s throttle never held and the sweep query ran ~490k
-- times/day. The function now only sweeps when called with
-- {"mode":"sweep"} and the service-role bearer; this job does that once a
-- minute.

select cron.unschedule('chain-transfer-webhook-sweep')
where exists (select 1 from cron.job where jobname = 'chain-transfer-webhook-sweep');

select cron.schedule(
  'chain-transfer-webhook-sweep',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/chain-transfer-webhook',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'claim_worker_service_key')
    ),
    body    := jsonb_build_object('mode', 'sweep')
  );
  $$
);
