-- Fix: fetch_and_lock_due_claims's single-claim branch (p_claim_id IS NOT NULL)
-- had no staleness check, unlike the cron-sweep branch (p_claim_id IS NULL).
-- MultichainClaimPage.tsx's "watch this screen" acceleration kick calls this
-- RPC with a specific p_claim_id every ~2-8s while a claim is non-terminal;
-- without the staleness guard, every one of those kicks re-locked and
-- reprocessed the claim immediately, with no rate limit at all. Traced in
-- production: one claim hit 1165 attempts in 40 minutes (~29/min) vs. the
-- ~6/min the design (MAX_ATTEMPTS=90, "~12-15 real minutes") assumed.
--
-- Fix: both branches now respect the same p_stale_cutoff.

CREATE OR REPLACE FUNCTION public.fetch_and_lock_due_claims(
  p_claim_id uuid DEFAULT NULL::uuid,
  p_stale_cutoff timestamp with time zone DEFAULT (now() - '00:00:06'::interval),
  p_limit integer DEFAULT 200
)
RETURNS SETOF claims
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  UPDATE public.claims
  SET updated_at = now()
  WHERE id IN (
    SELECT id
    FROM public.claims
    WHERE status IN ('submitted','bridging','verifying','settling')
      AND (
        (p_claim_id IS NOT NULL AND id = p_claim_id AND updated_at < p_stale_cutoff)
        OR (p_claim_id IS NULL AND updated_at < p_stale_cutoff)
      )
    ORDER BY updated_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$function$;
