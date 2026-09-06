-- supabase/migrations/20260825070000_bulkpay_attempt_reconcile_tracking.sql
--
-- Additive column supporting the second BulkPay reconciliation worklist
-- source (docs/BULKPAY_TRANSACTION_INTENT_IMPLEMENTATION.md) -- closes the
-- gap where a BulkPay transaction reaches CONFIRMED server-side (Phase 4)
-- but the client never successfully writes to bulk_payments at all, which
-- would otherwise leave chain_events/Ledger correlation permanently
-- unreachable for that transaction despite it being fully confirmed.
--
-- Mirrors bulk_payments.chain_events_verified_at (20260824090000_...sql)
-- exactly, on transaction_attempts instead.
--
-- NOT APPLIED to production as part of this change -- written only, per
-- the standing "do not apply migrations" instruction. Depends on the
-- Phase 1 canonical migration and the nonce-reservation migration already
-- being applied first.

ALTER TABLE public.transaction_attempts
  ADD COLUMN IF NOT EXISTS chain_events_reconciled_at timestamptz NULL;

COMMENT ON COLUMN public.transaction_attempts.chain_events_reconciled_at IS
  'Set once the BulkPay reconciliation path has processed this CONFIRMED attempt''s tx_hash via the transaction_attempt worklist source (independent of bulk_payments). NULL means not yet reconciled via this path -- a row may still be reconciled via the bulk_payments path first, in which case this column is never set at all (the two sources are deduplicated by tx_hash before processing, see bulkpayReconcile.ts). See docs/BULKPAY_TRANSACTION_INTENT_IMPLEMENTATION.md.';

CREATE INDEX IF NOT EXISTS idx_transaction_attempts_unreconciled_bulkpay
  ON public.transaction_attempts (created_at)
  WHERE chain_events_reconciled_at IS NULL AND status = 'CONFIRMED' AND tx_hash IS NOT NULL;
