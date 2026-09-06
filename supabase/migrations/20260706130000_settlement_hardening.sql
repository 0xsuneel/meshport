-- ═══════════════════════════════════════════════════════════════════════════
-- MeshPort: settlement pipeline hardening (operational, not architectural)
--
-- Settlement itself is already event-driven (CCTP MessageReceived log /
-- matched Transfer log, not wallet balance deltas). This migration addresses
-- the remaining operational fragility: no DB-enforced uniqueness on the two
-- columns that identify "this mint has already been claimed", optimistic
-- (timestamp-based) rather than true row locking for concurrent workers, and
-- no timing data to measure where settlement latency actually goes.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Uniqueness on destination_tx_hash — the actual guarantee that two claims
-- can never both complete against the same mint. The application-level
-- SELECT-then-UPDATE check in confirmArrival() narrows this window but does
-- not close it; concurrent worker invocations (a single-mode kick racing the
-- cron sweep, or two overlapping sweep passes) could still both pass the
-- SELECT check before either UPDATE commits. This constraint makes that
-- physically impossible regardless of application-level timing.
-- Partial (WHERE ... IS NOT NULL) because the column is legitimately NULL
-- for every non-terminal claim.
CREATE UNIQUE INDEX IF NOT EXISTS claims_destination_tx_hash_unique
  ON public.claims (destination_tx_hash)
  WHERE destination_tx_hash IS NOT NULL;

-- 2. Uniqueness on message_hash — same reasoning; a CCTP message hash
-- uniquely identifies one burn, so two claims should never carry the same one.
CREATE UNIQUE INDEX IF NOT EXISTS claims_message_hash_unique
  ON public.claims (message_hash)
  WHERE message_hash IS NOT NULL;

-- 3. Stage timestamps — lets settlement latency actually be measured
-- (settlement_duration, relay_duration, attestation_duration) instead of
-- only knowing created_at and completed_at. Each is set once, the first
-- time a claim enters that stage.
ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS bridging_at  timestamptz,
  ADD COLUMN IF NOT EXISTS verifying_at timestamptz,
  ADD COLUMN IF NOT EXISTS settling_at  timestamptz;

-- 4. Atomic, lock-based due-claims fetch — replaces the optimistic
-- timestamp-cutoff approach (STALE_LOCK_MS) as the AUTHORITATIVE mechanism
-- for "is another worker already handling this row".
--
-- IMPORTANT correctness note: a bare `SELECT ... FOR UPDATE SKIP LOCKED`
-- would NOT actually close the race here — each Supabase RPC call runs in
-- its own transaction, so that lock releases the instant this function
-- returns, before claim-worker's JS has done anything with the row. A
-- concurrent invocation querying a moment later could still select the same
-- row. The fix is the standard "atomic claim a batch of jobs" pattern:
-- combine FOR UPDATE SKIP LOCKED with an UPDATE...RETURNING in the SAME
-- statement, so "select it" and "mark it claimed" (bump updated_at) happen
-- together and durably — no gap for a second invocation to land in.
CREATE OR REPLACE FUNCTION public.fetch_and_lock_due_claims(
  p_claim_id uuid DEFAULT NULL,
  p_stale_cutoff timestamptz DEFAULT now() - interval '6 seconds',
  p_limit int DEFAULT 200
)
RETURNS SETOF public.claims
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.claims
  SET updated_at = now()
  WHERE id IN (
    SELECT id
    FROM public.claims
    WHERE status IN ('submitted','bridging','verifying','settling')
      AND (p_claim_id IS NOT NULL AND id = p_claim_id
           OR p_claim_id IS NULL AND updated_at < p_stale_cutoff)
    ORDER BY updated_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$;

GRANT EXECUTE ON FUNCTION public.fetch_and_lock_due_claims(uuid, timestamptz, int) TO service_role;

COMMENT ON FUNCTION public.fetch_and_lock_due_claims IS
  'Authoritative due-claims fetch for claim-worker. FOR UPDATE SKIP LOCKED guarantees no two concurrent worker invocations can process the same row, replacing the previous optimistic (timestamp-only) concurrency approach.';
