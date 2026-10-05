-- ═══════════════════════════════════════════════════════════════════════════
-- MeshPort Phase 1 — canonical transaction data model
--
-- See docs/PHASE_1_SCHEMA_DESIGN.md for the full design rationale (existing-
-- table audit, keep/extend/deprecate decisions, state model, idempotency
-- strategy, event-identity strategy, reorg strategy, RLS strategy).
--
-- SCOPE: purely additive. Creates four new tables (transaction_intents,
-- transaction_attempts, ledger_events, notification_events) and adds four
-- nullable link columns to existing tables (activity x2, claims x1,
-- multichain_transactions x1). Nothing existing is dropped, renamed, altered,
-- or redirected. No application code writes to any of this yet — that is
-- Phase 2 onward, one feature at a time.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- 1. transaction_intents — what the user asked to happen
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.transaction_intents (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who. user_id is nullable — many MeshPort accounts are wallet-only with
  -- no auth.users row (same reason claims.user_id is nullable). wallet_address
  -- is the true financial identity and is always present.
  user_id               uuid          REFERENCES auth.users(id) ON DELETE SET NULL,
  wallet_address        text          NOT NULL,

  -- What
  feature               text          NOT NULL
    CHECK (feature IN (
      'pay', 'receive', 'swap', 'multichain_transfer',
      'multichain_claim', 'bulkpay', 'chatpay', 'p2p'
    )),
  operation             text,         -- optional finer-grained label within a feature

  -- Idempotency. See docs/PHASE_1_SCHEMA_DESIGN.md §4 for why this is keyed
  -- on wallet_address rather than user_id (user_id is nullable; NULL <> NULL
  -- in a unique constraint, which would silently defeat the guard for every
  -- wallet-only user).
  idempotency_key       text          NOT NULL,

  -- Intent-level status only. See docs/PHASE_1_SCHEMA_DESIGN.md §3 for why
  -- this is deliberately separate from attempt status and ledger settlement
  -- status.
  status                text          NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN (
      'DRAFT', 'REVIEWED', 'AUTHORIZING', 'SUBMITTED',
      'CONFIRMED', 'FAILED', 'CANCELLED', 'EXPIRED'
    )),

  -- Amounts. Always atomic integer + explicit decimals — never a JS float.
  amount_atomic         numeric(78,0) NOT NULL CHECK (amount_atomic >= 0),
  token_address         text,
  token_symbol          text,
  decimals              integer       NOT NULL CHECK (decimals >= 0 AND decimals <= 76),

  source_chain          text,
  destination_chain     text,
  recipient_address     text,
  recipient_username    text,

  metadata               jsonb        NOT NULL DEFAULT '{}'::jsonb,

  failure_code            text,
  failure_message         text,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  completed_at              timestamptz,

  CONSTRAINT transaction_intents_wallet_idem_key UNIQUE (wallet_address, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_transaction_intents_wallet
  ON public.transaction_intents (wallet_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transaction_intents_user
  ON public.transaction_intents (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transaction_intents_status_sweep
  ON public.transaction_intents (status, updated_at)
  WHERE status IN ('AUTHORIZING', 'SUBMITTED');
CREATE INDEX IF NOT EXISTS idx_transaction_intents_feature
  ON public.transaction_intents (feature, created_at DESC);

COMMENT ON TABLE public.transaction_intents IS
  'Canonical record of what the user asked to happen, across all features (Pay, Receive, Swap, Multichain Transfer/Claim, BulkPay, ChatPay, P2P). Phase 1: schema only, no writers yet. See docs/PHASE_1_SCHEMA_DESIGN.md.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. transaction_attempts — each broadcast attempt toward an intent
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.transaction_attempts (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id     uuid          NOT NULL REFERENCES public.transaction_intents(id) ON DELETE CASCADE,

  chain_id      text          NOT NULL,
  tx_hash       text,
  nonce         bigint,

  -- Attempt-level status only — an intent may have multiple attempts
  -- (replacement/speed-up, or a retry after a DROPPED attempt).
  status        text          NOT NULL DEFAULT 'CREATED'
    CHECK (status IN (
      'CREATED', 'BROADCASTING', 'SUBMITTED', 'UNKNOWN',
      'CONFIRMING', 'CONFIRMED', 'REVERTED', 'DROPPED', 'REPLACED'
    )),

  submitted_at   timestamptz,
  confirmed_at   timestamptz,
  block_number   bigint,
  gas_used       numeric(38,0),
  gas_price      numeric(38,0),

  failure_code    text,
  failure_message text,

  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now()
);

-- One tx_hash per chain. Partial (tx_hash can be NULL before broadcast, e.g.
-- status='CREATED'). Supports future nonce-replacement: a replacement
-- transaction gets its own attempt row with its own (chain_id, tx_hash).
CREATE UNIQUE INDEX IF NOT EXISTS idx_transaction_attempts_chain_txhash
  ON public.transaction_attempts (chain_id, tx_hash) WHERE tx_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transaction_attempts_intent
  ON public.transaction_attempts (intent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transaction_attempts_status_sweep
  ON public.transaction_attempts (status, updated_at)
  WHERE status IN ('SUBMITTED', 'UNKNOWN', 'CONFIRMING');

COMMENT ON TABLE public.transaction_attempts IS
  'Each broadcast attempt toward a transaction_intent. Supports multiple attempts per intent (replace/speed-up, retry after DROPPED). Phase 1: schema only, no writers yet.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. ledger_events — canonical financial event layer
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ledger_events (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  transaction_intent_id    uuid          REFERENCES public.transaction_intents(id)  ON DELETE SET NULL,
  transaction_attempt_id   uuid          REFERENCES public.transaction_attempts(id) ON DELETE SET NULL,

  wallet_address           text          NOT NULL,
  chain_id                 text          NOT NULL,

  event_type               text          NOT NULL
    CHECK (event_type IN (
      'DEBIT', 'CREDIT', 'SWAP_DEBIT', 'SWAP_CREDIT',
      'BRIDGE_BURN', 'BRIDGE_MINT', 'UB_DEPOSIT', 'UB_SPEND',
      'ESCROW_LOCK', 'ESCROW_RELEASE', 'ESCROW_REFUND'
    )),
  direction                text          NOT NULL CHECK (direction IN ('debit', 'credit')),

  token_address            text,
  token_symbol             text,
  decimals                 integer       NOT NULL CHECK (decimals >= 0 AND decimals <= 76),
  amount_atomic            numeric(78,0) NOT NULL CHECK (amount_atomic > 0),

  tx_hash                  text,
  block_number              bigint,
  log_index                  integer,

  -- Deterministic dedup identity — see docs/PHASE_1_SCHEMA_DESIGN.md §6 for
  -- the exact construction per event class. This, not tx_hash alone, is the
  -- dedup guard (a single tx can contain multiple Transfer logs).
  event_key                    text        NOT NULL,

  settlement_status              text        NOT NULL DEFAULT 'PENDING'
    CHECK (settlement_status IN ('PENDING', 'POSTED', 'REVERSED')),

  metadata                          jsonb       NOT NULL DEFAULT '{}'::jsonb,

  created_at                          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ledger_events_event_key_key UNIQUE (event_key)
);

CREATE INDEX IF NOT EXISTS idx_ledger_events_wallet
  ON public.ledger_events (wallet_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_events_intent
  ON public.ledger_events (transaction_intent_id) WHERE transaction_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_events_attempt
  ON public.ledger_events (transaction_attempt_id) WHERE transaction_attempt_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_events_settlement_pending
  ON public.ledger_events (settlement_status, created_at) WHERE settlement_status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_ledger_events_txhash
  ON public.ledger_events (chain_id, tx_hash) WHERE tx_hash IS NOT NULL;

-- ── Raw-movement identity (docs/LEDGER_SCHEMA_GAP_AUDIT.md §1) ─────────────
-- event_key alone (see the COMMENT on that column below) includes event_type
-- as part of its string, so it CANNOT catch two rows for the identical raw
-- blockchain movement — same chain_id + tx_hash + log_index + wallet_address
-- — that got interpreted under two DIFFERENT event_type values (e.g. one
-- correctly SWAP_CREDIT, one incorrectly generic CREDIT because a
-- classification pass disagreed with itself, or raced a differently-decided
-- pass). Two different event_type values produce two different event_key
-- STRINGS, so UNIQUE(event_key) sees no conflict at all — a classification
-- bug could silently double-post a real financial movement.
--
-- This index closes that gap directly, deliberately EXCLUDING event_type
-- from what it compares: it is keyed on the raw movement's identity alone
-- (which wallet, which log, which transaction), not on what the interpreter
-- decided that movement meant. Deliberately does NOT include event_type,
-- and deliberately DOES include wallet_address — omitting wallet_address
-- would have been the wrong fix: one Transfer log legitimately produces TWO
-- ledger_events (a DEBIT row for the sender's wallet, a CREDIT row for the
-- recipient's wallet), and those two rows must both remain permitted. Only
-- the SAME wallet's SAME leg being interpreted twice is the bug this guards
-- against.
--
-- COALESCE(log_index, -1) mirrors the identical, already-proven pattern in
-- chain_events_dedup_idx (20260823080000_phase3_chain_events_identity_hardening.sql):
-- the native top-level-transfer scan path has no log at all, so log_index is
-- legitimately NULL there — without the COALESCE, Postgres's default "every
-- NULL is distinct" behavior would silently defeat this guard for exactly
-- that path (two rows with log_index IS NULL would never be seen as
-- conflicting by a plain index on the raw column).
CREATE UNIQUE INDEX IF NOT EXISTS ledger_events_raw_movement_key
  ON public.ledger_events (chain_id, tx_hash, COALESCE(log_index, -1), wallet_address)
  WHERE tx_hash IS NOT NULL;

COMMENT ON INDEX public.ledger_events_raw_movement_key IS
  'Raw-movement identity guard, deliberately separate from ledger_events_event_key_key. Prevents the SAME wallet''s SAME raw leg of the SAME log from being posted twice under two different event_type classifications (e.g. SWAP_CREDIT vs CREDIT for the same transfer) — event_key alone cannot catch this because event_type is part of that string. See docs/LEDGER_SCHEMA_GAP_AUDIT.md §1 and docs/LEDGER_RAW_IDENTITY_FIX.md for the full reasoning and validation.';

COMMENT ON TABLE public.ledger_events IS
  'Canonical financial event layer. Populated from confirmed blockchain activity (indexer/reconciler), never directly by the client. Phase 1: schema only, no writers yet.';
COMMENT ON COLUMN public.ledger_events.event_key IS
  'Deterministic dedup identity, NOT tx_hash alone. Format per event class documented in docs/PHASE_1_SCHEMA_DESIGN.md §6, e.g. "{chain_id}:{tx_hash}:{log_index}:{wallet_address}:{event_type}".';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. notification_events — canonical, idempotent domain-event notification log
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notification_events (
  id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Same nullability reasoning as transaction_intents.user_id. wallet_address
  -- is the fallback identity for wallet-only accounts.
  user_id                 uuid          REFERENCES auth.users(id) ON DELETE SET NULL,
  wallet_address          text          NOT NULL,

  transaction_intent_id   uuid          REFERENCES public.transaction_intents(id) ON DELETE SET NULL,

  event_key               text          NOT NULL,
  event_type               text          NOT NULL,

  payload                    jsonb         NOT NULL DEFAULT '{}'::jsonb,

  created_at                   timestamptz NOT NULL DEFAULT now(),
  delivered_at                   timestamptz
);

-- Dedup guard. user_id is nullable so this alone would under-protect
-- wallet-only accounts the same way (user_id, idempotency_key) would on
-- transaction_intents — add the wallet_address-keyed guard alongside it so
-- both identity paths are covered.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_events_user_key
  ON public.notification_events (user_id, event_key) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_events_wallet_key
  ON public.notification_events (wallet_address, event_key);

CREATE INDEX IF NOT EXISTS idx_notification_events_wallet_created
  ON public.notification_events (wallet_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_events_undelivered
  ON public.notification_events (created_at) WHERE delivered_at IS NULL;

COMMENT ON TABLE public.notification_events IS
  'Canonical, idempotent domain-event log feeding notification delivery for all features. Distinct from the existing P2P-specific public.notifications bell table — relationship between the two is a Phase 15 decision. Phase 1: schema only, no writers yet.';

-- ─────────────────────────────────────────────────────────────────────────
-- 5. updated_at triggers (same pattern as public.claims' existing trigger)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_transaction_intents_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transaction_intents_updated_at ON public.transaction_intents;
CREATE TRIGGER transaction_intents_updated_at
  BEFORE UPDATE ON public.transaction_intents
  FOR EACH ROW EXECUTE FUNCTION public.set_transaction_intents_updated_at();

CREATE OR REPLACE FUNCTION public.set_transaction_attempts_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transaction_attempts_updated_at ON public.transaction_attempts;
CREATE TRIGGER transaction_attempts_updated_at
  BEFORE UPDATE ON public.transaction_attempts
  FOR EACH ROW EXECUTE FUNCTION public.set_transaction_attempts_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- 6. RLS — deny-by-default for anon/authenticated on all four new tables.
--    service_role (used by Edge Functions / trusted server code) bypasses
--    RLS as usual. See docs/PHASE_1_SCHEMA_DESIGN.md §7 for why no
--    permissive policy is created yet — nothing in the client reads or
--    writes these tables until a feature is actually migrated (Phase 2+),
--    at which point the correct per-wallet scoping can be designed against
--    real auth-resolution requirements instead of guessed now.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.transaction_intents  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_events  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.transaction_intents  FROM anon, authenticated;
REVOKE ALL ON public.transaction_attempts FROM anon, authenticated;
REVOKE ALL ON public.ledger_events        FROM anon, authenticated;
REVOKE ALL ON public.notification_events  FROM anon, authenticated;

-- No CREATE POLICY statements for anon/authenticated — RLS with zero
-- permissive policies denies all access to those roles by default, while
-- service_role (bypasses RLS) continues to have full access, matching every
-- other server-owned table in this app (e.g. claims' service-role-only
-- write policy).

-- ─────────────────────────────────────────────────────────────────────────
-- 7. Additive link columns on existing tables — nullable, no default
--    behavior change, purely for future phases to join back to the
--    canonical model without another migration.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.activity
  ADD COLUMN IF NOT EXISTS transaction_intent_id uuid REFERENCES public.transaction_intents(id) ON DELETE SET NULL;
ALTER TABLE public.activity
  ADD COLUMN IF NOT EXISTS ledger_event_id uuid REFERENCES public.ledger_events(id) ON DELETE SET NULL;

ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS transaction_intent_id uuid REFERENCES public.transaction_intents(id) ON DELETE SET NULL;

ALTER TABLE public.multichain_transactions
  ADD COLUMN IF NOT EXISTS transaction_intent_id uuid REFERENCES public.transaction_intents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_activity_transaction_intent_id
  ON public.activity (transaction_intent_id) WHERE transaction_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_transaction_intent_id
  ON public.claims (transaction_intent_id) WHERE transaction_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_multichain_transactions_transaction_intent_id
  ON public.multichain_transactions (transaction_intent_id) WHERE transaction_intent_id IS NOT NULL;

COMMENT ON COLUMN public.activity.transaction_intent_id IS
  'Nullable link to the canonical transaction_intents row, added in Phase 1. NULL for all existing and near-term-future rows until Phase 14 (Activity projection cutover) starts populating it.';
COMMENT ON COLUMN public.claims.transaction_intent_id IS
  'Nullable link to the canonical transaction_intents row, added in Phase 1. Does not change claims.status semantics or the claim-worker''s ownership of this table.';
COMMENT ON COLUMN public.multichain_transactions.transaction_intent_id IS
  'Nullable link to the canonical transaction_intents row, added in Phase 1. multichain_transactions remains the live table for its current readers until Phases 9-11 migrate them.';
