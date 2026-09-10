-- ═══════════════════════════════════════════════════════════════════════════
-- MeshPort: add a 'settling' stage to the claims state machine
--
-- New lifecycle:
--   submitted -> bridging -> verifying -> settling -> completed
--                                                   \-> failed
--
-- 'verifying' now means "Circle attestation obtained, mint is expected".
-- 'settling' means "mint/credit is expected any moment now, waiting for the
-- balance to actually land and be confirmed" — this gives the UI a real,
-- worker-driven step between "we know it's coming" and "it's here", instead
-- of jumping straight from Verifying to Completed.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.claims DROP CONSTRAINT IF EXISTS claims_status_check;
ALTER TABLE public.claims ADD CONSTRAINT claims_status_check
  CHECK (status IN ('submitted','bridging','verifying','settling','completed','failed'));

DROP INDEX IF EXISTS public.idx_claims_status_sweep;
CREATE INDEX idx_claims_status_sweep
  ON public.claims (status, updated_at)
  WHERE status IN ('submitted','bridging','verifying','settling');
