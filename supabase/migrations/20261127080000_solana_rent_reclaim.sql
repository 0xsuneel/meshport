-- Daily: return the SOL rent MeshPort paid for Solana Brings' CCTP event
-- accounts (Circle's reclaim_event_account, 5 days after each burn) -
-- /api/solana-fee-payer action 'reclaim' (server/solana/reclaim.ts). Uses the
-- same internal secret as the push dispatcher (vault: p2p_push_secret).
select cron.unschedule('solana-rent-reclaim') where exists (select 1 from cron.job where jobname = 'solana-rent-reclaim');
select cron.schedule('solana-rent-reclaim', '17 4 * * *', $job$
  do $body$
  declare v_secret text;
  begin
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'p2p_push_secret';
    if v_secret is null then return; end if;
    perform net.http_post(
      url     := 'https://meshport.xyz/api/solana-fee-payer',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
      body    := jsonb_build_object('action', 'reclaim'),
      timeout_milliseconds := 60000
    );
  end $body$;
$job$);
