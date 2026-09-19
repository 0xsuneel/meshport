-- ═══════════════════════════════════════════════════════════════════════════
-- MeshPort Phase 3C/3D — chain_events event-identity hardening
--
-- See docs/PHASE_3_INDEXER_AUDIT.md §6/§7 for the full investigation this
-- migration is based on. Summary of the two problems it fixes:
--
-- 1. MISSING CANONICAL FIELDS (Phase 3C). chain_events currently has no
--    log_index, contract_address, event_signature, block_hash, or
--    transaction_index — all requested as minimum canonical fields and all
--    genuinely available for free in the RPC responses the indexer already
--    reads (eth_getLogs / eth_getBlockByNumber), just not being captured.
--    All five added as nullable columns — no existing row is touched, no
--    existing reader breaks.
--
-- 2. WRONG DEDUP IDENTITY (Phase 3D). The current unique index —
--      UNIQUE (event_type, chain_id, tx_hash, block_number)
--    — omits BOTH log_index and wallet_address. Verified against the live
--    scanner (supabase/functions/blockchain-indexer/scanner.ts): a single
--    BulkPay/Multicall3 transaction producing N `transfer_detected` events
--    to N different recipient wallets would insert N rows that are all
--    IDENTICAL under this index (same event_type, chain_id, tx_hash,
--    block_number — only wallet_address differs, which isn't in the index).
--    cursors.ts's insertEvents does a single unqualified `.insert(events)`
--    with no ON CONFLICT clause, so a same-batch collision fails the WHOLE
--    multi-row INSERT statement — not just the second row — and the
--    existing 23505-is-fine handling silently treats total data loss for
--    that transaction as "already published by a previous pass", which is
--    the wrong conclusion when the actual cause is a same-batch collision on
--    a first-time transaction. Latent today only because BulkPay/multi-
--    recipient event detection isn't implemented yet (see the audit) — this
--    fixes it at the identity/schema level before that coverage is added,
--    rather than after a real transaction is silently dropped.
--
--    Fix: replace the index with one that includes wallet_address AND
--    log_index. log_index is NULL for the native top-level-tx scan path
--    (a plain value transfer emits no log at all) — COALESCE(log_index, -1)
--    is used so two NULLs are still treated as identity-relevant instead of
--    Postgres's default "every NULL is distinct" behavior, which would
--    silently defeat the dedup guard for that path specifically.
--
-- Nothing here changes indexer_config, chain_cursors, indexer_shadow_reports,
-- or any RLS/grants already in place on chain_events. Nothing here changes
-- what the indexer writes TO activity/claims/balances (it still writes to
-- neither) — this is entirely about chain_events' own correctness.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. New canonical columns, all nullable, all additive ───────────────────
ALTER TABLE public.chain_events
  ADD COLUMN IF NOT EXISTS log_index integer;
ALTER TABLE public.chain_events
  ADD COLUMN IF NOT EXISTS contract_address text;
ALTER TABLE public.chain_events
  ADD COLUMN IF NOT EXISTS event_signature text;
ALTER TABLE public.chain_events
  ADD COLUMN IF NOT EXISTS block_hash text;
ALTER TABLE public.chain_events
  ADD COLUMN IF NOT EXISTS transaction_index integer;

COMMENT ON COLUMN public.chain_events.log_index IS
  'Log position within the transaction, for log-derived events (ERC-20 Transfer scan, native-transfer-log scan). NULL for the native top-level-tx scan path, which has no log at all. Part of the dedup identity — see chain_events_dedup_idx below.';
COMMENT ON COLUMN public.chain_events.contract_address IS
  'The contract that emitted the log (token contract, or the native-transfer-log contract on Arc). NULL for the native top-level-tx scan path — there is no contract, the transfer is a plain value transfer.';
COMMENT ON COLUMN public.chain_events.event_signature IS
  'Human-readable event signature, e.g. "Transfer(address,address,uint256)" — informational, not part of any index. NULL where not applicable (native top-level-tx path).';
COMMENT ON COLUMN public.chain_events.block_hash IS
  'Hash of the block this event was observed in, captured directly from the RPC response that already produced this event — no extra call. Useful for audit/debug cross-checking against chain_cursors.last_indexed_hash; not itself part of reorg detection, which remains cursor-level.';
COMMENT ON COLUMN public.chain_events.transaction_index IS
  'Position of the transaction within its block, captured directly from the RPC response that already produced this event — no extra call.';

-- ── 2. Fix the dedup identity ────────────────────────────────────────────────
DROP INDEX IF EXISTS public.chain_events_dedup_idx;

CREATE UNIQUE INDEX IF NOT EXISTS chain_events_dedup_idx
  ON public.chain_events (event_type, chain_id, tx_hash, wallet_address, COALESCE(log_index, -1))
  WHERE (tx_hash IS NOT NULL);

COMMENT ON INDEX public.chain_events_dedup_idx IS
  'Event-level dedup identity: chain_id + tx_hash + log_index (COALESCE''d to -1 for the native top-level-tx path, which has no log_index, so two such events for the same tx/wallet/type still collide as intended) + wallet_address + event_type. Deliberately NOT tx_hash alone — one transaction can produce multiple Transfer logs to different wallets (BulkPay/Multicall3 being the concrete case that motivated this fix — see migration header).';
