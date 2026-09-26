-- supabase/migrations/20260825060000_bulkpay_nonce_reservation.sql
--
-- Additive migration supporting server-side nonce reservation for BulkPay
-- (and, generically, any future feature migrated to the transaction state
-- machine that needs the same protection) -- docs/
-- BULKPAY_TRANSACTION_INTENT_IMPLEMENTATION.md.
--
-- Confirmed before writing this file: transaction_attempts has NO
-- wallet_address column at all -- the wallet only lives on the parent
-- transaction_intents row (direct schema read, this session). This means a
-- concurrency-safe "one nonce per (chain, wallet) at a time" constraint
-- cannot be expressed as a simple UNIQUE index on transaction_attempts
-- alone today -- a genuine, real gap, not assumed.
--
-- NOT APPLIED to production as part of this change -- written only, per the
-- standing "do not apply migrations automatically" instruction. Depends on
-- the Phase 1 canonical migration (20260823060000_...sql) already being
-- applied first, since transaction_attempts must exist for this ALTER to
-- run.

-- Denormalized from the parent intent, purely so a per-wallet uniqueness
-- constraint can be expressed directly on this table without a join. Kept
-- in sync by the application code that creates the attempt (it always has
-- the intent's wallet_address in hand at that point) -- not a source of
-- truth on its own; transaction_intents.wallet_address remains canonical.
ALTER TABLE public.transaction_attempts
  ADD COLUMN IF NOT EXISTS wallet_address text;

-- The actual concurrency-safety guarantee Phase 2 of the implementation
-- requires: two concurrent requests for the SAME wallet, on the SAME
-- chain, attempting to reserve the SAME nonce, cannot both succeed. A
-- genuine collision (two concurrent BulkPay clicks) is caught here at the
-- database layer, not merely by application-level locking, which cannot be
-- trusted alone across multiple server invocations/connections.
--
-- Partial (WHERE nonce IS NOT NULL) for the same reason
-- idx_transaction_attempts_chain_txhash is partial: an attempt legitimately
-- starts at status='CREATED' with no nonce yet reserved in some designs,
-- though the BulkPay implementation in this change always reserves the
-- nonce at creation time -- kept partial for forward compatibility with any
-- future flow that doesn't.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transaction_attempts_wallet_nonce
  ON public.transaction_attempts (chain_id, wallet_address, nonce)
  WHERE nonce IS NOT NULL AND wallet_address IS NOT NULL;

COMMENT ON COLUMN public.transaction_attempts.wallet_address IS
  'Denormalized from the parent transaction_intents row, solely to support idx_transaction_attempts_wallet_nonce (a direct per-table constraint needs this column locally -- Postgres unique indexes cannot span a join). Not authoritative on its own; transaction_intents.wallet_address remains the canonical value. See docs/BULKPAY_TRANSACTION_INTENT_IMPLEMENTATION.md.';
