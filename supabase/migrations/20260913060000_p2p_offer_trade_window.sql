-- ─────────────────────────────────────────────────────────────────────────
-- Adds trade_window_minutes to p2p_offers — how long a TRADE created
-- against this offer waits for the counterparty (buyer marking payment
-- sent, or the seller confirming on-chain) before it auto-expires. This is
-- NOT an offer-level expiry — offers themselves never expire, only
-- individual trades do (see isTradeExpired in src/lib/p2pService.ts).
--
-- Previously hardcoded as TRADE_WINDOW_MINUTES = 15 for every trade,
-- everywhere. This lets whoever creates the offer pick the window instead,
-- from a fixed set of durations (enforced by the CHECK constraint below so
-- a bad client can't set an arbitrary value): 15/30/60/120 minutes,
-- 6/12/24 hours.
--
-- Written once, at createOffer() (src/lib/p2pService.ts), and copied onto
-- each trade's own expires_at at createTrade() time — trades don't read
-- this column live, they carry their own snapshot so a later offer edit
-- never changes the countdown on a trade already in flight.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE public.p2p_offers
  ADD COLUMN IF NOT EXISTS trade_window_minutes integer NOT NULL DEFAULT 15;

ALTER TABLE public.p2p_offers
  DROP CONSTRAINT IF EXISTS p2p_offers_trade_window_minutes_check;

ALTER TABLE public.p2p_offers
  ADD CONSTRAINT p2p_offers_trade_window_minutes_check
  CHECK (trade_window_minutes IN (15, 30, 60, 120, 360, 720, 1440));

COMMENT ON COLUMN public.p2p_offers.trade_window_minutes IS
  'How long (minutes) a trade created against this offer waits for the counterparty before auto-expiring. One of 15/30/60/120/360/720/1440 (15m-24h). Copied onto each trade''s own expires_at at creation, not read live.';
