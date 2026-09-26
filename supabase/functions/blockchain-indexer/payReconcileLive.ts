// supabase/functions/blockchain-indexer/payReconcileLive.ts
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { rpcCallRace } from './scanner.ts'
import type { PayReconcileRepository, PayReceiptFetcher, PayWorklistRow, RawTransaction, RawReceiptWithLogs } from './payReconcile.ts'

export function makeLivePayReconcileRepository(supabase: SupabaseClient): PayReconcileRepository {
  return {
    async findConfirmedUnreconciledPayAttempts(sinceIso: string): Promise<PayWorklistRow[]> {
      const { data, error } = await supabase
        .from('transaction_attempts')
        .select('id, chain_id, tx_hash, wallet_address, transaction_intents!inner(feature, token_address, token_symbol, recipient_address)')
        .eq('status', 'CONFIRMED')
        .eq('transaction_intents.feature', 'pay')
        .is('chain_events_reconciled_at', null)
        .not('tx_hash', 'is', null)
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: true })
        .limit(200)
      if (error) {
        console.error('[pay-reconcile] findConfirmedUnreconciledPayAttempts failed:', error.message)
        return []
      }
      const out: PayWorklistRow[] = []
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const intent = r.transaction_intents as { token_address: string | null; token_symbol: string | null; recipient_address: string | null } | null
        if (!intent?.recipient_address) continue
        out.push({
          attemptId: r.id as string,
          txHash: r.tx_hash as string,
          chainId: r.chain_id as string,
          payerWallet: r.wallet_address as string,
          recipientWallet: intent.recipient_address,
          isNative: !intent.token_address,
          tokenAddress: intent.token_address,
          tokenSymbol: intent.token_symbol,
        })
      }
      return out
    },

    async markReconciled(attemptId: string, reconciledAtIso: string): Promise<void> {
      const { error } = await supabase
        .from('transaction_attempts')
        .update({ chain_events_reconciled_at: reconciledAtIso })
        .eq('id', attemptId)
      if (error) console.error('[pay-reconcile] markReconciled failed:', error.message)
    },

    async insertChainEvent(row: Record<string, unknown>): Promise<void> {
      const { error } = await supabase.from('chain_events').insert(row)
      if (error && error.code !== '23505') {
        console.error('[pay-reconcile] chain_events insert failed:', error.message)
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
        console.error('[pay-reconcile] chainEventAlreadyExists check failed:', error.message)
        return false
      }
      return (data ?? []).length > 0
    },
  }
}

export function makeLivePayReceiptFetcher(rpcs: string[]): PayReceiptFetcher {
  return {
    async getTransaction(txHash: string): Promise<RawTransaction | null> {
      const result = await rpcCallRace(rpcs, 'eth_getTransactionByHash', [txHash])
      return (result ?? null) as RawTransaction | null
    },
    async getReceipt(txHash: string): Promise<RawReceiptWithLogs | null> {
      const result = await rpcCallRace(rpcs, 'eth_getTransactionReceipt', [txHash])
      return (result ?? null) as RawReceiptWithLogs | null
    },
  }
}
