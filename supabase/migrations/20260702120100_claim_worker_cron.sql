-- ═══════════════════════════════════════════════════════════════════════════
-- MeshPort: schedule claim-worker sweeps
--
-- This is what makes claim processing truly independent of the browser:
-- Supabase's own scheduler (pg_cron), NOT the page, is what keeps calling the
-- worker. Even if every browser tab is closed, the claim still advances.
--
-- claim-worker's "sweep" mode internally loops for ~50s (polling every ~8s)
-- before returning, so the effective poll interval is ~8s even though pg_cron
-- only re-triggers it once a minute — the loop is the fast path, the cron
-- schedule is the self-healing safety net if an invocation ever dies early.
--
-- IMPORTANT — run once, manually, in the Supabase SQL editor after deploying
-- the claim-worker function (values below are placeholders):
--   1. Store the service role key as a Vault secret (never hardcode it here):
--        select vault.create_secret('<SERVICE_ROLE_KEY>', 'claim_worker_service_key');
--   2. Replace <PROJECT_REF> below with your Supabase project ref.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule(
  'claim-worker-sweep',
  '* * * * *',  -- every minute; the function itself loops internally every ~8s
  $$
  SELECT net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/claim-worker',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'claim_worker_service_key')
    ),
    body    := jsonb_build_object('mode', 'sweep')
  );
  $$
);

-- To inspect / remove the schedule later:
--   select * from cron.job;
--   select cron.unschedule('claim-worker-sweep');
