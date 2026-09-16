// supabase/functions/blockchain-indexer/bulkpayReconcileLive.ts
//
// Real, live implementations of BulkpayReconcileRepository/ArcReceiptFetcher
// -- the only place in this feature that touches a real Supabase client or
// makes a real RPC call. Everything else (bulkpayReconcile.ts,
// bulkpayReconcileRepository.ts) is pure/dependency-injected and tested
// without either. Reuses rpcCallRace from scanner.ts directly rather than
// reimplementing retry/backoff logic -- no second RPC-retry policy invented.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { rpcCallRace } from './scanner.ts'
import type { BulkpayReconcileRepository, ArcReceiptFetcher } from './bulkpayReconcileRepository.ts'
import type { BulkPaymentWorklistRow, RawReceipt } from './bulkpayReconcile.ts'

export function makeLiveBulkpayReconcileRepository(supabase: SupabaseClient): BulkpayReconcileRepository {
  return {
    async findUnverifiedBulkPayments(sinceIso: string): Promise<BulkPaymentWorklistRow[]> {
      const { data, error } = await supabase
        .from('bulk_payments')
        .select('id, tx_hash, created_at')
        .is('chain_events_verified_at', null)
        .not('tx_hash', 'is', null)
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: true })
        .limit(200)
      if (error) {
        // Tolerates the migration not being applied yet (docs/
        // BULKPAY_RECONCILIATION_IMPLEMENTATION.md) -- a missing column
        // produces a Postgres error here, logged and treated as "nothing to
        // reconcile yet" rather than crashing the caller, the same
        // defensive pattern already used throughout this codebase.
        console.error('[bulkpay-reconcile] findUnverifiedBulkPayments failed (is the migration applied?):', error.message)
        return []
      }
      return (data ?? []).map((r: { id: string; tx_hash: string; created_at: string }) => ({ ...r, source: 'bulk_payments' as const }))
    },

    async findConfirmedBulkPayAttempts(sinceIso: string): Promise<BulkPaymentWorklistRow[]> {
      // Second worklist source (docs/BULKPAY_TRANSACTION_INTENT_IMPLEMENTATION.md)
      // -- transaction_attempts, joined implicitly via transaction_intents'
      // feature='bulkpay', independent of whether the client ever wrote to
      // bulk_payments at all. Tolerates the migration/table not being
      // applied yet exactly like findUnverifiedBulkPayments does.
      const { data, error } = await supabase
        .from('transaction_attempts')
        .select('id, tx_hash, created_at, transaction_intents!inner(feature)')
        .eq('status', 'CONFIRMED')
        .eq('transaction_intents.feature', 'bulkpay')
        .is('chain_events_reconciled_at', null)
        .not('tx_hash', 'is', null)
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: true })
        .limit(200)
      if (error) {
        console.error('[bulkpay-reconcile] findConfirmedBulkPayAttempts failed (is the migration applied?):', error.message)
        return []
      }
      return (data ?? []).map((r: { id: string; tx_hash: string; created_at: string }) => ({ id: r.id, tx_hash: r.tx_hash, created_at: r.created_at, source: 'transaction_attempt' as const }))
    },

    async markVerified(row: BulkPaymentWorklistRow, verifiedAtIso: string): Promise<void> {
      const table = row.source === 'transaction_attempt' ? 'transaction_attempts' : 'bulk_payments'
      const column = row.source === 'transaction_attempt' ? 'chain_events_reconciled_at' : 'chain_events_verified_at'
      const { error } = await supabase
        .from(table)
        .update({ [column]: verifiedAtIso })
        .eq('id', row.id)
      if (error) console.error('[bulkpay-reconcile] markVerified failed:', error.message)
    },

    async insertChainEvent(row: Record<string, unknown>): Promise<void> {
      // Identical idempotent-insert shape to cursors.ts's own insertEvents --
      // relies on the SAME chain_events_dedup_idx unique index (Phase 3),
      // not a second identity system.
      const { error } = await supabase.from('chain_events').insert(row)
      if (error && error.code !== '23505') {
        console.error('[bulkpay-reconcile] chain_events insert failed:', error.message)
      }
    },
  }
}

export function makeLiveArcReceiptFetcher(rpcs: string[]): ArcReceiptFetcher {
  return {
    async getTransactionReceipt(txHash: string): Promise<RawReceipt | null> {
      const result = await rpcCallRace(rpcs, 'eth_getTransactionReceipt', [txHash])
      return (result ?? null) as RawReceipt | null
    },
  }
}
