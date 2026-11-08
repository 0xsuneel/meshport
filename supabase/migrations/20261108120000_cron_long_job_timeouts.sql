-- Give the two long-running every-minute sweeps an HTTP timeout that fits
-- their run time. Without one, pg_net gives up after its 5 s default and
-- records a timeout (often mislabelled as "DNS time: 5000 ms") in
-- net._http_response, even though the function carries on and finishes 200.
-- Field 8 Nov: ~780 such timeouts in 6 h, almost all from these two jobs.
--
--  * chain-transfer-webhook sweep loops for WATCH_LOOP_MS (58 s) by design.
--  * blockchain-indexer 'index' runs take a few seconds, up to ~25 s.
--
-- Commands are unchanged apart from timeout_milliseconds; cron.schedule
-- with an existing name updates that job in place.

select cron.schedule('chain-transfer-webhook-sweep', '* * * * *', $$
  select net.http_post(
    url     := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/chain-transfer-webhook',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'claim_worker_service_key')
    ),
    body    := jsonb_build_object('mode', 'sweep'),
    timeout_milliseconds := 70000
  );
$$);

select cron.schedule('blockchain-indexer-shadow', '* * * * *', $$
  select net.http_post(
    url     := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/blockchain-indexer',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'claim_worker_service_key')
    ),
    body    := jsonb_build_object('mode', 'index'),
    timeout_milliseconds := 60000
  );
$$);
