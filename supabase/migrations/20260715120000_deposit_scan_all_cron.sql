-- ═══════════════════════════════════════════════════════════════════════════
-- MeshPort: schedule deposit-scan-all sweeps
--
-- Same reasoning as 20260702120100_claim_worker_cron.sql: Supabase's own
-- scheduler (pg_cron), not any browser tab, is what keeps this running — so
-- an external deposit (e.g. an exchange withdrawal sent straight to a
-- wallet's raw address, with no MeshPort chat message involved at all) still
-- gets recorded into `activity` even if the recipient never opens the app.
--
-- IMPORTANT — run once, manually, in the Supabase SQL editor after deploying
-- the deposit-scan-all function (values below are placeholders):
--   1. Reuse the same Vault secret claim-worker's cron already created, or
--      create one:
--        select vault.create_secret('<SERVICE_ROLE_KEY>', 'claim_worker_service_key');
--   2. Replace <PROJECT_REF> below with your Supabase project ref.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule(
  'deposit-scan-all-sweep',
  '*/2 * * * *',  -- every 2 minutes — deposits are rare relative to in-app sends, no need for claim-worker's ~8s cadence
  $$
  SELECT net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/deposit-scan-all',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'claim_worker_service_key')
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- To inspect / remove the schedule later:
--   select * from cron.job;
--   select cron.unschedule('deposit-scan-all-sweep');
