// supabase/functions/blockchain-indexer/bulkpayNonceRecoveryLive.ts
//
// Real, live implementations for the nonce-based broadcast recovery
// mechanism (bulkpayNonceRecovery.ts) -- the only place in this feature
// that touches a real Supabase client or makes a real RPC call. Mirrors
// bulkpayReconcileLive.ts's own shape exactly.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { rpcCallRace } from './scanner.ts'
import type { BlockFetcher, RawBlockWithTransactions, UnresolvedAttempt } from './bulkpayNonceRecovery.ts'

/** Reads transaction_attempts rows stuck in CREATED/BROADCASTING with no tx_hash, older than graceMinutes -- the Case 2 signal. */
export async function findUnresolvedAttempts(
  supabase: SupabaseClient,
  chainId: string,
  graceMinutes: number,
): Promise<UnresolvedAttempt[]> {
  const cutoff = new Date(Date.now() - graceMinutes * 60_000).toISOString()
  const { data, error } = await supabase
    .from('transaction_attempts')
    .select('id, intent_id, chain_id, wallet_address, nonce, created_at, transaction_intents!inner(feature)')
    .eq('chain_id', chainId)
    .in('status', ['CREATED', 'BROADCASTING'])
    .eq('transaction_intents.feature', 'bulkpay')
    .is('tx_hash', null)
    .not('nonce', 'is', null)
    .not('wallet_address', 'is', null)
    .lt('created_at', cutoff)
    .limit(100)
  if (error) {
    console.error('[bulkpay-nonce-recovery] findUnresolvedAttempts failed:', error.message)
    return []
  }
  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    intentId: r.intent_id as string,
    chainId: r.chain_id as string,
    walletAddress: r.wallet_address as string,
    nonce: Number(r.nonce),
    createdAt: r.created_at as string,
  }))
}

export function makeLiveBlockFetcher(rpcs: string[]): BlockFetcher {
  return {
    async getBlockWithTransactions(_chainId, blockNumber) {
      const result = await rpcCallRace(rpcs, 'eth_getBlockByNumber', ['0x' + blockNumber.toString(16), true])
      return (result ?? null) as RawBlockWithTransactions | null
    },
    async getCurrentBlockNumber(_chainId) {
      const result = await rpcCallRace(rpcs, 'eth_blockNumber', [])
      return Number(BigInt(result as string))
    },
  }
}

export function makeLiveAttemptUpdateRepository(supabase: SupabaseClient) {
  return {
    async markSubmitted(attemptId: string, txHash: string): Promise<void> {
      const { error } = await supabase
        .from('transaction_attempts')
        .update({ tx_hash: txHash, status: 'SUBMITTED', submitted_at: new Date().toISOString() })
        .eq('id', attemptId)
      if (error) console.error('[bulkpay-nonce-recovery] markSubmitted failed:', error.message)
    },
    async markReplaced(attemptId: string, _replacementTxHash: string): Promise<void> {
      const { error } = await supabase
        .from('transaction_attempts')
        .update({ status: 'REPLACED' })
        .eq('id', attemptId)
      if (error) console.error('[bulkpay-nonce-recovery] markReplaced failed:', error.message)
    },
    async transitionIntentToFailed(intentId: string): Promise<void> {
      // Same fix as bulkpayConfirmationLive.ts's transitionIntent -- set
      // completed_at consistently for every terminal transition, not just
      // this specific call site.
      const { error } = await supabase
        .from('transaction_intents')
        .update({ status: 'FAILED', completed_at: new Date().toISOString() })
        .eq('id', intentId)
        .eq('status', 'SUBMITTED')
      if (error) console.error('[bulkpay-nonce-recovery] transitionIntentToFailed failed:', error.message)
    },
  }
}
