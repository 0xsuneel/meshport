-- Keep MeshPort's payment APIs warm: once a minute, wake the Arc RPC proxy,
-- the relayer (with Arc's clients) and the pay-intent function, so a person's
-- first payment after a quiet spell (or a release) doesn't pay a cold start.
-- Field 7 Nov: a relay request spent 24 s before its handler ran.
select cron.schedule('keep-api-warm', '* * * * *', $$
  select net.http_post(
    url := 'https://meshport.xyz/api/arc-rpc',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('jsonrpc', '2.0', 'id', 1, 'method', 'eth_blockNumber', 'params', jsonb_build_array()),
    timeout_milliseconds := 10000
  );
  select net.http_get(
    url := 'https://meshport.xyz/api/bridge-relay?action=warm&chain=Arc_Testnet',
    timeout_milliseconds := 10000
  );
  select net.http_post(
    url := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/pay-intent',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- The function gateway needs a valid JWT; 'ping' answers before any auth.
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'claim_worker_service_key')
    ),
    body := jsonb_build_object('action', 'ping'),
    timeout_milliseconds := 10000
  );
$$);
