-- ═══════════════════════════════════════════════════════════════════════════
-- MeshPort Phase 2 — schema clarifications required before the state machine
--
-- Two small, additive fixes requested as explicit prerequisites for Phase 2
-- (see docs/PHASE_1_SCHEMA_DESIGN.md §13 "Phase 2 clarifications" for the
-- full write-up):
--
--   1. Token identity: ERC20 financial events must require token_address;
--      native-asset events may have it NULL. Phase 1 left token_address
--      nullable with no enforcement at all, which "weakens the rule
--      silently" (a bug could insert an ERC20 row with no token_address and
--      nothing would catch it). Fixed with an explicit is_native flag +
--      CHECK, not a hardcoded native-symbol list (fragile — see write-up).
--
--   2. Notification identity: Phase 1 created two overlapping unique
--      indexes on notification_events (one keyed on user_id, one on
--      wallet_address). Because wallet_address is NOT NULL on every row,
--      the wallet-keyed index alone already fully dedupes every row
--      regardless of whether user_id is set — the user_id-keyed partial
--      index added no protection beyond it and just created a second,
--      confusing dedup mechanism. Dropped in favor of ONE canonical key:
--      (wallet_address, event_key).
--
-- Nothing here changes transaction_intents, transaction_attempts, or the
-- shape of anything already relied on — additive/constraining only, and
-- both changes apply to tables that have had zero writers since Phase 1
-- (schema-only), so there is no existing data to violate the new CHECKs.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Token identity: is_native flag + enforcement ─────────────────────────
ALTER TABLE public.transaction_intents
  ADD COLUMN IF NOT EXISTS is_native boolean NOT NULL DEFAULT false;
ALTER TABLE public.ledger_events
  ADD COLUMN IF NOT EXISTS is_native boolean NOT NULL DEFAULT false;

ALTER TABLE public.transaction_intents
  DROP CONSTRAINT IF EXISTS transaction_intents_token_identity_check;
ALTER TABLE public.transaction_intents
  ADD CONSTRAINT transaction_intents_token_identity_check
  CHECK (is_native = true OR token_address IS NOT NULL);

ALTER TABLE public.ledger_events
  DROP CONSTRAINT IF EXISTS ledger_events_token_identity_check;
ALTER TABLE public.ledger_events
  ADD CONSTRAINT ledger_events_token_identity_check
  CHECK (is_native = true OR token_address IS NOT NULL);

COMMENT ON COLUMN public.transaction_intents.is_native IS
  'Explicitly set by the writer — true for the chain''s native asset (ETH, ARC, MATIC, AVAX, etc. depending on chain), false for any ERC20/token asset. Never inferred from token_symbol (symbol lists are fragile across the many testnets this app supports and drift as chains are added — see api/relay-gas.ts CHAIN_DEFS for how often that list grows). Drives transaction_intents_token_identity_check: false rows MUST have token_address set.';
COMMENT ON COLUMN public.ledger_events.is_native IS
  'Same meaning and same enforcement (ledger_events_token_identity_check) as transaction_intents.is_native. Set from the same source data the writer already has when constructing the ledger event — never defaulted or inferred.';

-- ── 2. Notification identity: one canonical dedup key ───────────────────────
-- Drop the redundant/confusing user_id-keyed partial unique index from
-- Phase 1. wallet_address is NOT NULL on every notification_events row, so
-- idx_notification_events_wallet_key (below, unchanged) already dedupes
-- every row on its own — keeping a second unique index keyed on user_id
-- meant the same logical event could, in principle, be reasoned about two
-- different ways depending on which identity field a caller happened to
-- populate. One key, not two.
DROP INDEX IF EXISTS public.idx_notification_events_user_key;

-- idx_notification_events_wallet_key already exists from Phase 1
-- (UNIQUE (wallet_address, event_key), no WHERE clause — applies to every
-- row) and is unchanged by this migration. Restated here only as documentation:
--   CREATE UNIQUE INDEX idx_notification_events_wallet_key
--     ON public.notification_events (wallet_address, event_key);
COMMENT ON TABLE public.notification_events IS
  'Canonical, idempotent domain-event log feeding notification delivery for all features. Distinct from the existing P2P-specific public.notifications bell table — relationship between the two is a Phase 15 decision. Dedup key is (wallet_address, event_key) ONLY (see idx_notification_events_wallet_key) — user_id is a convenience join column, not part of the identity. Phase 2: still schema only, no writers yet.';
