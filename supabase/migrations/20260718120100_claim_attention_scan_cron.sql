-- ═══════════════════════════════════════════════════════════════════════════
-- MeshPort: schedule claim-attention-scan sweeps
--
-- Same reasoning as deposit-scan-all's cron (20260715120000): Supabase's own
-- scheduler, not any browser tab, is what keeps this running — so funds that
-- land on an external chain get a push notification even if the recipient
-- never happens to open the Multichain Hub. See the function's own header
-- comment for why this exists and why 5 minutes (not deposit-scan-all's ~8s
-- cadence) is the right interval here: balance-appearing-on-an-external-
-- chain isn't as time-critical as an in-app payment, and N wallets x 20
-- chains on a tight loop would be an unnecessary RPC/API budget hit for a
-- gap this was closing from "hours or days" down to, not from "8 seconds"
-- down to "instant".
--
-- IMPORTANT — run once, manually, in the Supabase SQL editor after deploying
-- the claim-attention-scan function AND setting PUSH_INTERNAL_SECRET in both
-- this project's edge function secrets and Vercel's env vars (must be the
-- exact same value in both places). The project ref below (cvvpzfvzweszuuxvaayb)
-- is already filled in for this project — reuses the same Vault secret the
-- other cron jobs already created ('claim_worker_service_key'); confirm that
-- exists first with: select name from vault.decrypted_secrets where name =
-- 'claim_worker_service_key';
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule(
  'claim-attention-scan-sweep',
  '*/5 * * * *',  -- every 5 minutes
  $$
  SELECT net.http_post(
    url     := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/claim-attention-scan',
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
--   select cron.unschedule('claim-attention-scan-sweep');
