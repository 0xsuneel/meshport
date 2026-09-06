-- ═══════════════════════════════════════════════════════════════════════════
-- MeshPort Phase 4 — shadow validation: retention + comparison
--
-- Additive only. Does not touch chain_cursors, chain_events' existing columns,
-- deposit-scan-all, claim-worker or claim-recovery-scan. Nothing here makes
-- BlockchainIndexer authoritative — it adds the machinery to PROVE whether it
-- could be.
--
-- Two concerns:
--   1. Retention for chain_events (Phase 3 left it unbounded — flagged then).
--   2. A durable place to record shadow-comparison results, so accuracy is
--      measured over real traffic across many invocations rather than being
--      a number printed once into a log that scrolls away.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Retention configuration ──────────────────────────────────────────────
-- Configurable per the brief, not a hardcoded interval. A row per policy so
-- an operator can change retention with an UPDATE and no deploy.
CREATE TABLE IF NOT EXISTS indexer_config (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE indexer_config IS
  'Runtime configuration for BlockchainIndexer. Changeable by UPDATE without a deploy — retention windows, shadow-mode flags, per-chain overrides.';

INSERT INTO indexer_config (key, value, description) VALUES
  (
    'retention',
    jsonb_build_object(
      -- Confirmed events are the useful history: how long a consumer can look
      -- back. 14 days comfortably covers the shadow-validation period plus
      -- any incident investigation, without letting the table grow forever.
      'confirmed_days', 14,
      -- Reorged events are kept LONGER than confirmed ones on purpose. They
      -- are the audit trail for "why did this balance change and then change
      -- back" — exactly the question asked weeks later, and the reason the
      -- indexer marks events reorged instead of deleting them.
      'reorged_days', 30,
      -- Pending events that never confirmed are almost always the residue of
      -- a crashed pass. Short window: they carry no audit value and a
      -- long-pending event is a bug signal, not history.
      'pending_days', 2
    ),
    'chain_events retention windows, in days, by status. Applied by prune_chain_events().'
  ),
  (
    'shadow_mode',
    jsonb_build_object('enabled', true, 'authoritative', false),
    'While authoritative=false, BlockchainIndexer output is compared but never acted upon. Production cutover flips this — deliberately a config change, not a deploy.'
  )
ON CONFLICT (key) DO NOTHING;

-- ── 2. Retention function ───────────────────────────────────────────────────
-- Reads its windows from indexer_config so changing retention is an UPDATE.
-- Deletes in bounded batches: an unbounded DELETE on a large table takes a
-- long-lived lock, and this runs on a cron against a live database.
CREATE OR REPLACE FUNCTION prune_chain_events(p_batch_limit int DEFAULT 5000)
RETURNS TABLE (deleted_confirmed int, deleted_reorged int, deleted_pending int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cfg              jsonb;
  v_confirmed_days int;
  v_reorged_days   int;
  v_pending_days   int;
  n_confirmed      int := 0;
  n_reorged        int := 0;
  n_pending        int := 0;
BEGIN
  SELECT value INTO cfg FROM indexer_config WHERE key = 'retention';

  -- Defaults mirror the seeded row, so a missing/corrupt config row degrades
  -- to sane behaviour instead of deleting everything or nothing.
  v_confirmed_days := COALESCE((cfg->>'confirmed_days')::int, 14);
  v_reorged_days   := COALESCE((cfg->>'reorged_days')::int,   30);
  v_pending_days   := COALESCE((cfg->>'pending_days')::int,    2);

  WITH doomed AS (
    SELECT id FROM chain_events
    WHERE status = 'confirmed'
      AND created_at < now() - make_interval(days => v_confirmed_days)
    LIMIT p_batch_limit
  )
  DELETE FROM chain_events e USING doomed d WHERE e.id = d.id;
  GET DIAGNOSTICS n_confirmed = ROW_COUNT;

  WITH doomed AS (
    SELECT id FROM chain_events
    WHERE status = 'reorged'
      AND created_at < now() - make_interval(days => v_reorged_days)
    LIMIT p_batch_limit
  )
  DELETE FROM chain_events e USING doomed d WHERE e.id = d.id;
  GET DIAGNOSTICS n_reorged = ROW_COUNT;

  WITH doomed AS (
    SELECT id FROM chain_events
    WHERE status = 'pending'
      AND created_at < now() - make_interval(days => v_pending_days)
    LIMIT p_batch_limit
  )
  DELETE FROM chain_events e USING doomed d WHERE e.id = d.id;
  GET DIAGNOSTICS n_pending = ROW_COUNT;

  RETURN QUERY SELECT n_confirmed, n_reorged, n_pending;
END;
$$;

COMMENT ON FUNCTION prune_chain_events IS
  'Deletes chain_events past their per-status retention window (from indexer_config.retention). Batched to avoid long locks; run repeatedly to drain a large backlog.';

-- ── 3. Shadow comparison results ────────────────────────────────────────────
-- Each run of the indexer's `compare` mode writes one row. Persisted rather
-- than logged because the cutover decision needs a TREND ("has the indexer
-- matched the existing worker on every deposit for 48 hours?"), and a log line
-- cannot answer that after the fact.
CREATE TABLE IF NOT EXISTS indexer_shadow_reports (
  id                bigserial PRIMARY KEY,
  generated_at      timestamptz NOT NULL DEFAULT now(),

  -- What was compared: 'deposits' | 'claims'
  scope             text NOT NULL,
  -- How far back this comparison looked.
  window_minutes    integer NOT NULL,

  -- Both systems saw it. This is the number that must be high.
  matched           integer NOT NULL DEFAULT 0,
  -- Legacy worker recorded it, indexer did NOT. THE critical metric: every
  -- row here is something the indexer would have missed if it were
  -- authoritative. Cutover requires this at zero over a sustained window.
  worker_only       integer NOT NULL DEFAULT 0,
  -- Indexer saw it, legacy worker did not (yet). Not necessarily a fault —
  -- the indexer may simply be faster, or may have found something the worker
  -- genuinely missed. Needs eyeballing, not alarm.
  indexer_only      integer NOT NULL DEFAULT 0,

  -- matched / (matched + worker_only). NULL when there was nothing to compare,
  -- which is materially different from 0% and must not be averaged as if it
  -- were.
  recall_pct        numeric(5,2),

  -- The actual mismatching keys, so a discrepancy can be investigated rather
  -- than just counted. Bounded in the writer to avoid unbounded payloads.
  details           jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS indexer_shadow_reports_recent_idx
  ON indexer_shadow_reports (scope, generated_at DESC);

COMMENT ON TABLE indexer_shadow_reports IS
  'Per-run output of BlockchainIndexer shadow comparison against the legacy workers. worker_only is the cutover gate: it must be sustained at zero before the indexer can become authoritative.';

-- ── 4. Retention for the reports themselves ────────────────────────────────
-- Small rows, but this table would otherwise also grow without bound.
CREATE OR REPLACE FUNCTION prune_shadow_reports(p_keep_days int DEFAULT 30)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n int := 0;
BEGIN
  DELETE FROM indexer_shadow_reports
  WHERE generated_at < now() - make_interval(days => p_keep_days);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ── 5. RLS ──────────────────────────────────────────────────────────────────
-- Operational tables. No client reads these; service_role only, same posture
-- as chain_cursors.
ALTER TABLE indexer_config          ENABLE ROW LEVEL SECURITY;
ALTER TABLE indexer_shadow_reports  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.indexer_config         FROM anon, authenticated;
REVOKE ALL ON public.indexer_shadow_reports FROM anon, authenticated;

DROP POLICY IF EXISTS indexer_config_service_all         ON public.indexer_config;
DROP POLICY IF EXISTS indexer_shadow_reports_service_all ON public.indexer_shadow_reports;

CREATE POLICY indexer_config_service_all ON public.indexer_config
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY indexer_shadow_reports_service_all ON public.indexer_shadow_reports
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 6. Schedules ────────────────────────────────────────────────────────────
-- Project ref and vault secret name are taken from the EXISTING worker crons
-- (claim_worker_cron, deposit_scan_all_cron) rather than invented, so all four
-- schedules authenticate the same way. If the project is ever migrated, every
-- cron in this directory needs the same edit — grep for the ref.
--
-- These three schedules are the ONLY behavioural change in this migration, and
-- none of them touch a legacy worker: two invoke the shadow indexer, one prunes
-- the indexer's own tables.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Indexer shadow pass. Every 2 minutes, NOT every minute: deposit-scan-all
-- already runs each minute and remains the source of truth, so the indexer
-- only needs enough cadence to prove it sees the same things. Halving the
-- frequency halves the shadow RPC cost during validation.
SELECT cron.unschedule('blockchain-indexer-shadow')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'blockchain-indexer-shadow');

SELECT cron.schedule(
  'blockchain-indexer-shadow',
  '*/2 * * * *',
  $CRON$
  SELECT net.http_post(
    url     := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/blockchain-indexer',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'claim_worker_service_key')
    ),
    body    := jsonb_build_object('mode', 'index')
  );
  $CRON$
);

-- Comparison pass. Every 15 minutes, looking back 60 — overlapping windows on
-- purpose, so an event landing near a boundary is compared by two runs rather
-- than falling between them.
SELECT cron.unschedule('blockchain-indexer-compare')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'blockchain-indexer-compare');

SELECT cron.schedule(
  'blockchain-indexer-compare',
  '*/15 * * * *',
  $CRON$
  SELECT net.http_post(
    url     := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/blockchain-indexer',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'claim_worker_service_key')
    ),
    body    := jsonb_build_object('mode', 'compare', 'windowMinutes', 60)
  );
  $CRON$
);

-- Retention. Daily, off-peak, and deliberately at an odd minute so it does not
-- pile onto the top-of-hour cron burst.
SELECT cron.unschedule('chain-events-retention')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'chain-events-retention');

SELECT cron.schedule(
  'chain-events-retention',
  '23 3 * * *',
  $CRON$
  SELECT prune_chain_events(20000);
  SELECT prune_shadow_reports(30);
  $CRON$
);

-- To inspect or remove:
--   select jobname, schedule from cron.job;
--   select cron.unschedule('blockchain-indexer-shadow');
--   select cron.unschedule('blockchain-indexer-compare');
--   select cron.unschedule('chain-events-retention');
--
-- To change retention without a deploy:
--   update indexer_config
--      set value = jsonb_set(value, '{confirmed_days}', '30'), updated_at = now()
--    where key = 'retention';
