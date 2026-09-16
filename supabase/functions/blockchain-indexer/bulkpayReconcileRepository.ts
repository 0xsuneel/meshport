// supabase/functions/blockchain-indexer/bulkpayReconcileRepository.ts
//
// The ONLY DB/RPC boundary for BulkPay reconciliation — dependency-injected,
// matching the exact discipline already used in server/ledger/repository.ts.
// No implementation lives here; index.ts supplies a real one (Supabase +
// Arc RPC) when wiring this into the existing indexer function.

import type { BulkPaymentWorklistRow, RawReceipt } from './bulkpayReconcile.ts'

export interface BulkpayReconcileRepository {
  /** Recent bulk_payments rows with a real tx_hash, not yet reconciled. Read-only -- never returns recipient data, only the tx_hash pointer. */
  findUnverifiedBulkPayments(sinceIso: string): Promise<BulkPaymentWorklistRow[]>

  /**
   * Recent transaction_attempts rows (feature='bulkpay', status='CONFIRMED')
   * with a real tx_hash, not yet reconciled -- the second worklist source,
   * closing the gap where a BulkPay transaction reaches CONFIRMED
   * server-side (Phase 4) but the client never successfully wrote to
   * bulk_payments at all (the exact scenario the transaction_intent/attempt
   * architecture exists to survive). Same read-only, pointer-only contract
   * as findUnverifiedBulkPayments -- recipient/amount data always comes
   * from the independently-decoded real receipt, never from either source.
   */
  findConfirmedBulkPayAttempts(sinceIso: string): Promise<BulkPaymentWorklistRow[]>

  /** Marks one worklist row as reconciled -- routes to bulk_payments.chain_events_verified_at or transaction_attempts.chain_events_reconciled_at based on row.source, set only AFTER real chain_events rows are confirmed written, never before. */
  markVerified(row: BulkPaymentWorklistRow, verifiedAtIso: string): Promise<void>

  /**
   * Inserts a chain_events row using the SAME dedup mechanism the main
   * scanner already relies on (onConflict on the existing
   * chain_events_dedup_idx unique index, ignoreDuplicates) -- this module
   * does not invent a second identity system (Phase 6's explicit
   * instruction). A duplicate insert (retry, or a leg the main scan already
   * separately captured) is a safe, silent no-op, exactly like
   * cursors.ts's own insertEvents.
   */
  insertChainEvent(row: Record<string, unknown>): Promise<void>
}

export interface ArcReceiptFetcher {
  /** Real RPC eth_getTransactionReceipt call. Returns null if the transaction cannot be resolved (fabricated/wrong tx_hash) -- never throws for "not found". */
  getTransactionReceipt(txHash: string): Promise<RawReceipt | null>
}
