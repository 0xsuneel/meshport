-- supabase/migrations/20260824090000_bulkpay_reconcile_tracking.sql
--
-- Minimal, additive column supporting the BulkPay reconciliation path
-- (docs/BULKPAY_RECONCILIATION_IMPLEMENTATION.md,
-- docs/BULKPAY_INTENT_SCOPED_WATCH_DESIGN.md §6, Option B-refined).
--
-- Confirmed before writing this file: bulk_payments has no existing
-- idempotency/verification field (direct schema read via
-- information_schema.columns), so a new column is genuinely required --
-- not a redundant migration. Nothing else about bulk_payments changes:
-- no column removed, no existing row touched, no constraint tightened.
--
-- NOT APPLIED to production as part of this change -- written only, per
-- the standing "do not apply migrations" instruction. The reconciliation
-- code in supabase/functions/blockchain-indexer/bulkpayReconcile.ts is
-- written to tolerate this column not existing yet (see that file's own
-- comments) so it can be reviewed and tested locally before this migration
-- is ever applied.

ALTER TABLE public.bulk_payments
  ADD COLUMN IF NOT EXISTS chain_events_verified_at timestamptz NULL;

COMMENT ON COLUMN public.bulk_payments.chain_events_verified_at IS
  'Set once the BulkPay reconciliation path has independently decoded this transaction''s real on-chain recipients and ensured a chain_events row exists for each one (regardless of users.wallet_address registration). NULL means not yet reconciled. This column is never set from client-declared data -- only after an independent server-side RPC re-read of the real transaction. See docs/BULKPAY_RECONCILIATION_IMPLEMENTATION.md.';

-- Lets the reconciliation worklist query ("recent, unverified bulk_payments
-- rows with a real tx_hash") run efficiently without a full table scan.
CREATE INDEX IF NOT EXISTS idx_bulk_payments_unreconciled
  ON public.bulk_payments (created_at)
  WHERE chain_events_verified_at IS NULL AND tx_hash IS NOT NULL;
