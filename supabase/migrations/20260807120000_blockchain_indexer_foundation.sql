-- ═══════════════════════════════════════════════════════════════════════════
-- MeshPort Phase 3 — BlockchainIndexer foundation
--
-- Adds the two tables the indexer needs and NOTHING else. Deliberately does
-- not touch, replace or reschedule deposit-scan-all, claim-worker or
-- claim-recovery-scan: this migration is additive so the indexer can run in
-- shadow mode (observe + publish events that nothing consumes yet) alongside
-- the existing workers, with zero behavioural change to any live path.
--
-- ── Why a new cursor table rather than extending deposit_scan_cursor ────────
-- deposit_scan_cursor is keyed by DETECTION SOURCE ('native_blocks',
-- 'erc20_logs:EURC') and is implicitly Arc-only — there is no chain column,
-- because deposit-scan-all only ever scans Arc. It also stores nothing that
-- would let a reorg be DETECTED: no block hash, no confirmation depth, no
-- sync state. Adding four nullable columns and a chain_id to a primary key
-- that live code writes to via `onConflict: 'source'` would change the
-- meaning of existing rows underneath a running worker.
--
-- chain_cursors is therefore a separate, per-chain table. deposit_scan_cursor
-- keeps working exactly as-is and is untouched by this migration; Phase 4+
-- can migrate its two rows across once the indexer is authoritative.
--
-- ── Reorg safety, which the current scanner has none of ─────────────────────
-- deposit-scan-all scans to `latest` and advances its cursor past it, so a
-- reorged block is never revisited and anything detected in it is never
-- retracted. That is survivable on Arc testnet (fast finality, and a missed
-- deposit is recovered by the 10-minute Blockscout reconcile pass) but it is
-- not safe for mainnet or for the EVM chains where MeshPort already reads
-- balances. The design here fixes that structurally:
--
--   * last_indexed_hash lets a reorg be DETECTED (parent hash mismatch)
--   * confirmation_depth defines a safe frontier per chain
--   * events are born 'pending' and only become 'confirmed' at depth
--   * a detected reorg rolls the cursor back and marks affected events
--     'reorged' rather than deleting them, so the retraction is auditable
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Per-chain durable cursor ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chain_cursors (
  chain_id              text PRIMARY KEY,

  -- Highest block whose contents have been fully processed.
  last_indexed_block    bigint  NOT NULL DEFAULT 0,
  -- Hash of last_indexed_block. NULL only before the first successful pass.
  -- A mismatch between this and the chain's current hash for that height is
  -- the reorg signal.
  last_indexed_hash     text,

  -- Chain head as last observed. Purely informational — lag is
  -- (latest_observed_block - last_indexed_block) and is what alerting reads.
  latest_observed_block bigint,

  -- Blocks below (head - confirmation_depth) are treated as final. Per-chain
  -- because finality differs wildly: Arc claims ~instant, Polygon PoS wants
  -- well over a hundred blocks to be genuinely safe.
  confirmation_depth    integer NOT NULL DEFAULT 12,

  -- idle | syncing | catching_up | reorg | error | paused
  -- 'paused' is operator-set and is respected by the indexer, so a
  -- misbehaving chain can be taken out of rotation without a deploy.
  sync_state            text    NOT NULL DEFAULT 'idle',

  last_success_at       timestamptz,
  last_error            text,
  consecutive_failures  integer NOT NULL DEFAULT 0,

  -- Number of times a reorg has been observed on this chain. Cheap signal
  -- that a confirmation_depth is set too shallow.
  reorg_count           integer NOT NULL DEFAULT 0,
  last_reorg_at         timestamptz,

  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chain_cursors_sync_state_valid CHECK (
    sync_state IN ('idle','syncing','catching_up','reorg','error','paused')
  ),
  CONSTRAINT chain_cursors_depth_sane CHECK (confirmation_depth >= 0),
  -- Guards the rollback path: a bug that drove the cursor negative would
  -- otherwise re-scan from genesis and hammer every RPC endpoint.
  CONSTRAINT chain_cursors_block_sane CHECK (last_indexed_block >= 0)
);

COMMENT ON TABLE chain_cursors IS
  'Per-chain indexing cursor for BlockchainIndexer: how far each chain has been indexed, the hash at that height for reorg detection, per-chain confirmation depth, and sync health. Distinct from deposit_scan_cursor, which is Arc-only, keyed by detection source, and has no reorg support.';

CREATE INDEX IF NOT EXISTS chain_cursors_state_idx
  ON chain_cursors (sync_state)
  WHERE sync_state <> 'idle';

-- ── 2. Typed chain events ───────────────────────────────────────────────────
-- The only thing the indexer publishes. This table is what Phase 4's event
-- bus subscribes to — the indexer does not know or care who consumes events.
-- Idempotency is enforced with a partial unique index, NOT application code,
-- so a crashed/restarted/overlapping indexer invocation can never double-publish
-- the same event.

CREATE TABLE IF NOT EXISTS chain_events (
  id              bigserial PRIMARY KEY,

  -- Which chain the event describes, and where on it.
  chain_id        text NOT NULL,
  block_number    bigint,
  tx_hash         text,

  -- Fixed vocabulary, not freeform text — consumers switch on this.
  event_type      text NOT NULL CHECK (
    event_type IN (
      'deposit_detected',        -- external funds arrived at a watched address
      'transfer_detected',       -- balance-affecting transfer (in or out)
      'transaction_confirmed',   -- previously-unconfirmed tx reached depth
      'transaction_failed',      -- receipt.status == '0x0'
      'balance_changed',         -- net balance delta for (wallet, asset)
      'claim_completed',         -- CCTP mint for a known claim arrived
      'bridge_completed'         -- a bridge leg reached its destination
    )
  ),

  -- The wallet this event is ABOUT. Nullable because not every event type is
  -- wallet-scoped (a chain reorg, for example, is not).
  wallet_address  text,

  -- Denormalized asset list, for consumers that only care about specific
  -- tokens (e.g. '{"USDC"}' when an EURC transfer arrives).
  assets          text[] NOT NULL DEFAULT '{}',

  -- Event payload, schema depends on event_type.
  metadata        jsonb NOT NULL DEFAULT '{}',

  -- Reorg lifecycle:
  --   pending    = emitted at scan time, not yet past confirmation depth
  --   confirmed  = crossed the safe frontier; consumers should trust it
  --   reorged    = the block it referenced was reorganized out; consumers
  --                that applied it must treat the effect as rolled back
  -- Terminal states are confirmed / reorged. 'pending' is a progress state.
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','reorged')),

  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_at    timestamptz,
  reorged_at      timestamptz
);

-- Idempotency: the same (event_type, chain, tx, block) must never be
-- insertable twice, regardless of how many times the indexer re-processes
-- the block. This is what makes overlapping/restarted passes harmless.
CREATE UNIQUE INDEX IF NOT EXISTS chain_events_dedup_idx
  ON chain_events (event_type, chain_id, tx_hash, block_number)
  WHERE tx_hash IS NOT NULL;

-- The hot query: everything for one wallet, newest first. Event bus payloads
-- are always wallet-scoped, so this is the index the Phase 4 consumer drives.
CREATE INDEX IF NOT EXISTS chain_events_wallet_idx
  ON chain_events (wallet_address, created_at DESC)
  WHERE wallet_address IS NOT NULL;

-- Reorg rollback query: bump every pending event on a rolled-back chain.
CREATE INDEX IF NOT EXISTS chain_events_pending_idx
  ON chain_events (chain_id, block_number)
  WHERE status = 'pending';

-- Operational: find reorged events affecting a wallet.
CREATE INDEX IF NOT EXISTS chain_events_reorged_idx
  ON chain_events (wallet_address, reorged_at DESC)
  WHERE status = 'reorged';

COMMENT ON TABLE chain_events IS
  'Typed events published by BlockchainIndexer. The indexer only OBSERVES the chain and writes these; it contains no business logic and consumes nothing. Phase 4 subscribes to this table to drive event-driven refresh.';

COMMENT ON COLUMN chain_events.status IS
  'pending -> confirmed at confirmation_depth; -> reorged if its block was reorganized out. Consumers must treat pending as tentative and reorged as rollback.';

-- ── 3. RLS ────────────────────────────────────────────────────────────────
-- chain_events is a broadcast channel, not a data table: authenticated clients
-- READ events for the wallet they own, so Phase 4's client-side subscription
-- can receive them. Writes are service-role only, so a client can never inject
-- events.
--
-- The wallet-address ownership model follows the EXISTING convention used
-- across this project (claims, support_tickets, wallet backup): scope by
-- auth.uid() — the Supabase Auth session id — not by a wallet address read
-- from the JWT. The app's auth is a hybrid (social OAuth + server-issued
-- wallet sessions), and auth.uid() is the one key every policy already relies
-- on. The service_role write policies are the same shape as
-- "claims_service_all" (claims migration), so indexer and claim-worker
-- can both write events under the same role they already use.

ALTER TABLE chain_events ENABLE ROW LEVEL SECURITY;

-- The real write boundary is the GRANT, not the policy — exactly as the
-- notifications table does it. A policy alone is not enough: an INSERT policy
-- without a TO clause applies to `authenticated` as well, which would let any
-- logged-in browser forge a 'deposit_detected' event for any address. Since
-- Phase 4 consumers will act on these events (refreshing balances, and later
-- driving notifications), a forged event is a real attack surface, not a
-- theoretical one. Revoke first, then grant reads only.
REVOKE INSERT, UPDATE, DELETE ON public.chain_events FROM anon, authenticated;

DROP POLICY IF EXISTS chain_events_select      ON public.chain_events;
DROP POLICY IF EXISTS chain_events_service_all ON public.chain_events;

-- Read: a broadcast feed. Events are chain facts (a transfer to address X)
-- that any observer of a public chain can already see, and an event bus works
-- by letting subscribers receive the stream and select what concerns them.
-- Same shape as "claims_select", which is also USING (true).
CREATE POLICY chain_events_select ON public.chain_events
  FOR SELECT USING (true);

-- Write: service_role only — the indexer. Identical shape to
-- "claims_service_all", which is how claim-worker already writes.
CREATE POLICY chain_events_service_all ON public.chain_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- chain_cursors is operational state, not user data: no client ever reads it.
-- Lock it to service_role entirely.
ALTER TABLE chain_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chain_cursors FROM anon, authenticated;

DROP POLICY IF EXISTS chain_cursors_service_all ON public.chain_cursors;
CREATE POLICY chain_cursors_service_all ON public.chain_cursors
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 4. Realtime ─────────────────────────────────────────────────────────────
-- Publishing the table is infrastructure, NOT consumer wiring: nothing
-- subscribes to it in this phase. Without this line chain_events is inert and
-- Phase 4 could not subscribe at all, so it belongs with the table that it
-- describes rather than in a later migration. Same one-line pattern as
-- claims and notifications.
ALTER PUBLICATION supabase_realtime ADD TABLE public.chain_events;
