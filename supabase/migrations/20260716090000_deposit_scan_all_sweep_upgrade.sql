-- ═══════════════════════════════════════════════════════════════════════════
-- MeshPort: deposit-scan-all latency fix — cursor table + sweep/reconcile cron
--
-- ROOT CAUSE this fixes: deposit-scan-all previously ran ONE PASS per
-- invocation, triggered by pg_cron every 2 minutes, with no internal loop —
-- unlike claim-worker, which self-loops every ~8s for ~50s per invocation.
-- That meant external-deposit detection latency was bounded by the cron
-- schedule itself (up to 2 minutes), which is exactly the delay reported
-- between "balance updates" (client-side chain polling, decoupled) and
-- "activity row appears" (this worker).
--
-- This migration:
--   1. Adds `deposit_scan_cursor` — a small persisted-cursor table so each
--      sweep pass scans only the true gap since the last successful scan,
--      instead of re-scanning a fixed lookback window from scratch every
--      time (the old behavior had no cursor at all).
--   2. Reschedules the existing 'deposit-scan-all-sweep' cron job to match
--      claim-worker's cadence (every 1 minute; the function's own internal
--      loop is the real ~8s fast path, same as claim-worker).
--   3. Adds a new, infrequent 'deposit-scan-all-reconcile' cron job
--      (every 10 minutes) that calls the SAME function in `mode: 'reconcile'`
--      — this is the Blockscout-backed backstop pass, demoted from primary
--      detector to safety net per the reviewed architecture. It recovers
--      anything the direct-RPC sweep might have missed; it is not on the
--      fast path.
--
-- No new function/service is introduced — same single `deposit-scan-all`
-- worker, same pattern claim-worker already uses (mode: 'sweep' /
-- mode: 'reconcile' via the same self-looping-invocation + cron-safety-net
-- design).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 1. Persisted scan cursor — one row per detection source.
CREATE TABLE IF NOT EXISTS deposit_scan_cursor (
  source             text PRIMARY KEY,   -- 'native_blocks' | 'erc20_logs:<SYMBOL>'
  last_scanned_block bigint NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE deposit_scan_cursor IS
  'Last block successfully scanned per deposit-detection source, so deposit-scan-all only scans the gap since its previous run instead of a fixed lookback window from scratch every time.';

-- 2. Reschedule the sweep job to run every 1 minute (matches claim-worker's
--    cron cadence; the function's own internal loop, not this cron
--    frequency, is what gives near-real-time detection).
SELECT cron.unschedule('deposit-scan-all-sweep')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'deposit-scan-all-sweep');

SELECT cron.schedule(
  'deposit-scan-all-sweep',
  '* * * * *',  -- every minute; the function itself loops internally every ~8s
  $$
  SELECT net.http_post(
    url     := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/deposit-scan-all',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'claim_worker_service_key')
    ),
    body    := jsonb_build_object('mode', 'sweep')
  );
  $$
);

-- 3. New infrequent reconcile job — Blockscout-backed backstop only.
SELECT cron.unschedule('deposit-scan-all-reconcile')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'deposit-scan-all-reconcile');

SELECT cron.schedule(
  'deposit-scan-all-reconcile',
  '*/10 * * * *',  -- every 10 minutes — backstop only, not the fast path
  $$
  SELECT net.http_post(
    url     := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/deposit-scan-all',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'claim_worker_service_key')
    ),
    body    := jsonb_build_object('mode', 'reconcile')
  );
  $$
);

-- IMPORTANT — the URLs above are already set to your project
-- (cvvpzfvzweszuuxvaayb.supabase.co). Reuses the same Vault secret
-- ('claim_worker_service_key') that job already depended on — no new secret
-- needed.
--
-- To inspect / remove the schedules later:
--   select * from cron.job;
--   select cron.unschedule('deposit-scan-all-sweep');
--   select cron.unschedule('deposit-scan-all-reconcile');
