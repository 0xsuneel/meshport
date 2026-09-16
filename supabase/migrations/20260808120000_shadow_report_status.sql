-- ═══════════════════════════════════════════════════════════════════════════
-- MeshPort — shadow comparison: explicit result status
--
-- Additive. Adds two columns to indexer_shadow_reports and backfills the
-- existing rows. Touches nothing else: no worker, no cursor, no event, no
-- detection logic, no cron schedule.
--
-- ── Why this column is necessary ────────────────────────────────────────────
-- matched / worker_only / indexer_only are NOT NULL DEFAULT 0, so the table
-- physically cannot express "not measured" — zero is the only thing it can
-- store. That makes two opposite conclusions indistinguishable:
--
--     worker_only = 0  ->  "the indexer missed nothing"      (a real pass)
--     worker_only = 0  ->  "nothing was compared"            (no evidence)
--
-- The deployed reports hit exactly this: 40 rows of zeros that look like
-- passes but measured nothing. An explicit status is the only way to keep a
-- quiet or non-comparable window from reading as success.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.indexer_shadow_reports
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS reason text;

-- ── Backfill: every pre-existing row is unmeasured, not passing ─────────────
-- All existing rows were produced by the pre-fix comparison, which
--   (a) filtered both tables by row-insertion time, so a catching-up indexer's
--       events never met their worker counterparts, and
--   (b) treated ordinary deposit events as claim candidates.
-- Their counts cannot be trusted in either direction, so they are marked
-- NOT_COMPARABLE rather than left NULL (ambiguous) or guessed at.
UPDATE public.indexer_shadow_reports
   SET status = 'NOT_COMPARABLE',
       reason = 'produced by pre-fix comparison logic (creation-time windowing; '
                'deposit events counted as claim candidates) — counts not trustworthy'
 WHERE status IS NULL;

-- Enforce the vocabulary only after backfilling, so the UPDATE above cannot
-- collide with the constraint.
ALTER TABLE public.indexer_shadow_reports
  DROP CONSTRAINT IF EXISTS indexer_shadow_reports_status_valid;

ALTER TABLE public.indexer_shadow_reports
  ADD CONSTRAINT indexer_shadow_reports_status_valid
  CHECK (status IN ('PASS', 'FAIL', 'NOT_COMPARABLE', 'NOT_APPLICABLE'));

ALTER TABLE public.indexer_shadow_reports
  ALTER COLUMN status SET NOT NULL;

COMMENT ON COLUMN public.indexer_shadow_reports.status IS
  'PASS = real comparison, indexer matched the worker. FAIL = real comparison, discrepancy found. NOT_COMPARABLE = window could not be trusted (indexer behind head, or nothing in window) — counts are meaningless. NOT_APPLICABLE = scope is not the indexer''s responsibility (claims are owned by claim-worker). Only PASS/FAIL rows carry evidential weight.';

COMMENT ON COLUMN public.indexer_shadow_reports.reason IS
  'Human-readable justification for the status. Always populated for non-PASS rows.';

-- ── Tunable comparability threshold ────────────────────────────────────────
-- How far behind head the indexer may be and still produce a trustworthy
-- comparison. Beyond this its events describe blocks older than the window,
-- so its rows and the worker''s rows for the same transaction fall into
-- different windows. ~600 blocks is about five minutes on Arc (1.96
-- blocks/sec, measured). Changeable by UPDATE, no deploy required.
INSERT INTO public.indexer_config (key, value, description) VALUES
  (
    'comparison',
    jsonb_build_object('max_backlog_blocks', 600),
    'Shadow comparison tuning. max_backlog_blocks: maximum indexer lag (in blocks) for a comparison window to be considered valid; beyond it, reports are NOT_COMPARABLE.'
  )
ON CONFLICT (key) DO NOTHING;

-- ── Cutover gate, corrected ────────────────────────────────────────────────
-- Replaces counting-based gates that could pass on unmeasured windows. Only
-- PASS/FAIL rows count as evidence; NOT_COMPARABLE and NOT_APPLICABLE are
-- explicitly excluded rather than being averaged in as zeros.
CREATE OR REPLACE VIEW public.shadow_gate_status AS
WITH graded AS (
  SELECT *
    FROM public.indexer_shadow_reports
   WHERE scope = 'deposits'
     AND status IN ('PASS', 'FAIL')
     AND generated_at > now() - interval '24 hours'
)
SELECT
  (SELECT count(*) FROM graded)                                    AS graded_windows,
  (SELECT count(*) FROM graded WHERE status = 'PASS')              AS passing_windows,
  (SELECT coalesce(sum(matched), 0)      FROM graded)              AS total_matched,
  (SELECT coalesce(sum(worker_only), 0)  FROM graded)              AS total_worker_only,
  (SELECT coalesce(sum(indexer_only), 0) FROM graded)              AS total_indexer_only,
  CASE
    WHEN (SELECT count(*) FROM graded) = 0
      THEN 'NO EVIDENCE — no comparable window in the last 24h'
    WHEN (SELECT coalesce(sum(matched), 0) FROM graded) = 0
      THEN 'NO EVIDENCE — zero matched events; nothing was actually compared'
    WHEN (SELECT coalesce(sum(worker_only), 0) FROM graded) > 0
      THEN 'FAIL — indexer missed ' || (SELECT sum(worker_only) FROM graded) || ' event(s)'
    WHEN (SELECT coalesce(sum(indexer_only), 0) FROM graded) > 0
      THEN 'REVIEW — ' || (SELECT sum(indexer_only) FROM graded) || ' indexer-only event(s) need explanation'
    ELSE 'DEPOSITS GATE MET — restart recovery and native USDC checks still manual'
  END AS gate;

COMMENT ON VIEW public.shadow_gate_status IS
  'Deposit-scope cutover gate over the last 24h of COMPARABLE windows only. Claims are excluded by design: claim-worker owns that lifecycle and the indexer emits no claim events, so the claims scope reports NOT_APPLICABLE and is not a cutover metric.';
