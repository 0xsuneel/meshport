// supabase/functions/blockchain-indexer/swapReconcileLive.ts
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { rpcCallRace } from './scanner.ts'
import type { SwapReconcileRepository, SwapReceiptFetcher, SwapWorklistRow, RawReceiptWithLogs } from './swapReconcile.ts'

export function makeLiveSwapReconcileRepository(supabase: SupabaseClient): SwapReconcileRepository {
  return {
    async findConfirmedUnreconciledSwapAttempts(sinceIso: string): Promise<SwapWorklistRow[]> {
      const { data, error } = await supabase
        .from('transaction_attempts')
        .select('id, intent_id, chain_id, tx_hash, wallet_address, transaction_intents!inner(feature)')
        .eq('status', 'CONFIRMED')
        .eq('transaction_intents.feature', 'swap')
        .is('chain_events_reconciled_at', null)
        .not('tx_hash', 'is', null)
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: true })
        .limit(200)
      if (error) {
        console.error('[swap-reconcile] findConfirmedUnreconciledSwapAttempts failed:', error.message)
        return []
      }
      const out: SwapWorklistRow[] = []
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        if (!r.wallet_address || !r.tx_hash) continue
        out.push({
          attemptId: r.id as string,
          intentId: r.intent_id as string,
          txHash: r.tx_hash as string,
          chainId: r.chain_id as string,
          walletAddress: r.wallet_address as string,
        })
      }
      return out
    },

    async markReconciled(attemptId: string, reconciledAtIso: string): Promise<void> {
      const { error } = await supabase
        .from('transaction_attempts')
        .update({ chain_events_reconciled_at: reconciledAtIso })
        .eq('id', attemptId)
      if (error) console.error('[swap-reconcile] markReconciled failed:', error.message)
    },

    async insertChainEvent(row: Record<string, unknown>): Promise<void> {
      const { error } = await supabase.from('chain_events').insert(row)
      if (error && error.code !== '23505') {
        console.error('[swap-reconcile] chain_events insert failed:', error.message)
      }
    },

    async chainEventAlreadyExists(chainId: string, txHash: string, walletAddress: string): Promise<boolean> {
      const { data, error } = await supabase
        .from('chain_events')
        .select('id')
        .eq('chain_id', chainId)
        .eq('tx_hash', txHash)
        .eq('wallet_address', walletAddress)
        .limit(1)
      if (error) {
        console.error('[swap-reconcile] chainEventAlreadyExists check failed:', error.message)
        return false
      }
      return (data ?? []).length > 0
    },
  }
}

export function makeLiveSwapReceiptFetcher(rpcs: string[]): SwapReceiptFetcher {
  return {
    async getReceipt(txHash: string): Promise<RawReceiptWithLogs | null> {
      const result = await rpcCallRace(rpcs, 'eth_getTransactionReceipt', [txHash])
      return (result ?? null) as RawReceiptWithLogs | null
    },
  }
}
