-- ═══════════════════════════════════════════════════════════════════════════
-- MeshPort: claims table — true background processing for Multichain Claim
--
-- Replaces client-side (page-lifecycle-bound) polling with a server-owned
-- state machine. A claim row is the single source of truth for a claim's
-- progress and is advanced ONLY by the claim-worker Edge Function
-- (service_role). The frontend never writes status transitions directly —
-- it only INSERTs (via the claim-submit Edge Function) and SELECTs/subscribes.
--
-- Status lifecycle:
--   submitted -> bridging -> verifying -> completed
--                                      \-> failed
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.claims (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who
  user_id             uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  wallet_address      text        NOT NULL,

  -- What
  source_chain        text        NOT NULL,
  amount              numeric(18,6) NOT NULL CHECK (amount > 0),

  -- Chain data captured as the claim progresses
  tx_hash             text        NOT NULL,        -- burn tx hash (submitted by client at insert time)
  bridge_tx_hash       text,                        -- confirmed burn/bridge tx (worker-verified)
  message_hash        text,                        -- CCTP message hash, used to poll attestation
  destination_tx_hash text,                         -- mint / credit tx hash on Arc (worker-discovered)

  -- Worker bookkeeping
  arc_balance_before  numeric(30,6),                -- Arc USDC balance snapshot at submit time
  attempts            integer     NOT NULL DEFAULT 0,
  error               text,

  -- Status lifecycle
  status              text        NOT NULL DEFAULT 'submitted'
                                  CHECK (status IN ('submitted','bridging','verifying','completed','failed')),

  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Efficient lookups: per-wallet history (Hub) and worker sweep queries
CREATE INDEX IF NOT EXISTS idx_claims_wallet        ON public.claims (wallet_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claims_status_sweep   ON public.claims (status, updated_at) WHERE status IN ('submitted','bridging','verifying');
CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_tx_hash ON public.claims (tx_hash);

-- Auto-update updated_at on every row change
CREATE OR REPLACE FUNCTION public.set_claims_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS claims_updated_at ON public.claims;
CREATE TRIGGER claims_updated_at
  BEFORE UPDATE ON public.claims
  FOR EACH ROW EXECUTE FUNCTION public.set_claims_updated_at();

-- ── Row Level Security ────────────────────────────────────────────────────────
-- Reads are public (wallet-scoped filtering happens client-side, same pattern
-- as bridge_sessions). Writes are service_role ONLY — status transitions must
-- only ever come from the trusted claim-worker Edge Function, never the browser.
ALTER TABLE public.claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "claims_select"       ON public.claims;
DROP POLICY IF EXISTS "claims_service_all"  ON public.claims;

CREATE POLICY "claims_select" ON public.claims
  FOR SELECT USING (true);

CREATE POLICY "claims_service_all" ON public.claims
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Realtime ───────────────────────────────────────────────────────────────────
-- Frontend subscribes to row UPDATEs (and INSERTs for the Hub list) instead of
-- polling. This is what lets the UI update live without any setInterval.
ALTER PUBLICATION supabase_realtime ADD TABLE public.claims;
