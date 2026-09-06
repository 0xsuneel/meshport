-- ============================================================
-- Fix: claim-worker-sweep cron job was missing the Authorization
-- header entirely.
--
-- claim-worker (the Edge Function) has verify_jwt = true, which means
-- Supabase's own gateway rejects any request with no valid JWT/apikey
-- BEFORE the function's own code ever runs. The cron job dispatching to
-- it (jobid 6, 'claim-worker-sweep', '* * * * *') was calling
-- net.http_post with ONLY a url — no headers argument at all — so
-- every single scheduled invocation was rejected with 401, for this
-- job's entire history. Multichain claim processing never actually ran
-- via cron as a result (confirmed: the `claims` table had exactly 1
-- row, ever, before this fix).
--
-- Fix mirrors the already-correct pattern used by deposit-scan-all-sweep
-- (jobid 12), which pulls the same vault secret ('claim_worker_service_key'
-- — named after claim-worker, evidently created for this exact purpose
-- and never wired up to it) and sends it as a Bearer token.
--
-- This migration makes that live fix (applied directly via
-- cron.alter_job during investigation) reproducible for any other
-- environment running `supabase db push` from this repo.
-- ============================================================

select cron.alter_job(
  (select jobid from cron.job where jobname = 'claim-worker-sweep'),
  command := $$
    select net.http_post(
      url := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/claim-worker',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'claim_worker_service_key')
      )
    );
  $$
);
