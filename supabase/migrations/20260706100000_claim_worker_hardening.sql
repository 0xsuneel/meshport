-- ═══════════════════════════════════════════════════════════════════════════
-- MeshPort: claim-worker hardening
--
-- Fixes the root causes behind claims stalling permanently in 'settling':
--   1. Adds columns needed for event-based settlement (real destination tx,
--      relay time, block) instead of the balance-delta heuristic.
--   2. Adds an atomic attempts-increment RPC so concurrent single/sweep
--      invocations can't lose updates to each other.
--   3. Adds `error` / `last_error_at` write path (already had `error`, this
--      just documents intent) and `needs_review` for the stuck-claim watchdog.
--   4. Rebuilds the sweep index to match the columns the worker actually
--      queries/orders/paginates on now.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS relay_timestamp timestamptz,
  ADD COLUMN IF NOT EXISTS receiver_block   bigint,
  ADD COLUMN IF NOT EXISTS last_error_at    timestamptz,
  ADD COLUMN IF NOT EXISTS needs_review     boolean NOT NULL DEFAULT false;

-- Atomic, single-statement attempts increment — replaces the app-level
-- `attempts: (claim.attempts ?? 0) + 1` read-then-write, which can lose
-- updates when `single` mode (kicked by claim-submit) and the `sweep` cron
-- race on the same row within the same few seconds.
CREATE OR REPLACE FUNCTION public.increment_claim_attempts(p_claim_id uuid)
RETURNS public.claims
LANGUAGE sql
AS $$
  UPDATE public.claims
  SET attempts = attempts + 1
  WHERE id = p_claim_id
  RETURNING *;
$$;

GRANT EXECUTE ON FUNCTION public.increment_claim_attempts(uuid) TO service_role;

-- Sweep query now explicitly orders + paginates (oldest-due first), so a
-- growing backlog degrades gracefully instead of risking PostgREST's default
-- page cap silently omitting arbitrary rows on every pass. This index makes
-- that ORDER BY cheap.
DROP INDEX IF EXISTS public.idx_claims_status_sweep;
CREATE INDEX idx_claims_status_sweep
  ON public.claims (status, updated_at)
  WHERE status IN ('submitted','bridging','verifying','settling');

-- Watchdog: cheap view for "how many claims have been in-flight too long,
-- and for how long" — used by the worker's stuck-claim check and can also
-- be queried directly / hooked into external alerting.
CREATE OR REPLACE VIEW public.stuck_claims AS
SELECT
  id, wallet_address, status, attempts, updated_at, created_at,
  EXTRACT(EPOCH FROM (now() - updated_at)) AS seconds_since_update,
  error, needs_review
FROM public.claims
WHERE status IN ('submitted','bridging','verifying','settling')
  AND updated_at < now() - interval '10 minutes';

GRANT SELECT ON public.stuck_claims TO service_role;
