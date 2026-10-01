-- claims.amount is set once at submission time (what the user claimed) and
-- never updated. Every history view (Hub, Activity feed, detail card) reads
-- this same value, so a claim showing "+$3.00" may have actually only
-- credited $2.98 after a real CCTP/relay fee — the UI silently shows the
-- claimed amount, not what genuinely arrived.
--
-- This adds a separate column for the real, verified arrived amount,
-- captured directly from the on-chain Transfer log at the moment of
-- completion (claim-worker's amount-matching fallback path already parses
-- this value during matching — it just wasn't being persisted). `amount`
-- is left untouched as "what was claimed"; `arrived_amount` is "what
-- genuinely landed", NULL until a claim completes via that path.
ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS arrived_amount numeric;

ALTER TABLE public.activity
  ADD COLUMN IF NOT EXISTS arrived_amount numeric;

COMMENT ON COLUMN public.claims.amount IS
  'Amount the user claimed/requested. Does NOT reflect fees deducted before mint — see arrived_amount for the real on-chain-verified figure.';
COMMENT ON COLUMN public.claims.arrived_amount IS
  'Actual amount verified minted on Arc, parsed directly from the on-chain Transfer log at completion time. NULL if completed via the CCTP MessageReceived path (which does not currently decode the transfer amount) rather than the amount-matching fallback.';
