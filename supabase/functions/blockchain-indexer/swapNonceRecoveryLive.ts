// supabase/functions/blockchain-indexer/swapNonceRecoveryLive.ts
//
// Real, live implementations for Swap's UNKNOWN/broadcast-response-loss
// recovery (swapNonceRecovery.ts). Mirrors payNonceRecoveryLive.ts's own
// shape, using the same KIT_ADAPTER_CONTRACT constant swapConfirmationLive.ts
// uses for expectedTo.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { rpcCallRace } from './scanner.ts'
import { KIT_ADAPTER_CONTRACT } from './swapConfirmationLive.ts'
import type { BlockFetcher, RawBlockWithTransactions, UnresolvedSwapAttempt } from './swapNonceRecovery.ts'

export async function findUnresolvedSwapAttempts(
  supabase: SupabaseClient,
  chainId: string,
  graceMinutes: number,
): Promise<UnresolvedSwapAttempt[]> {
  const cutoff = new Date(Date.now() - graceMinutes * 60_000).toISOString()
  const { data, error } = await supabase
    .from('transaction_attempts')
    .select('id, intent_id, chain_id, wallet_address, nonce, created_at, transaction_intents!inner(feature)')
    .eq('chain_id', chainId)
    .in('status', ['CREATED', 'BROADCASTING'])
    .eq('transaction_intents.feature', 'swap')
    .is('tx_hash', null)
    .not('nonce', 'is', null)
    .not('wallet_address', 'is', null)
    .lt('created_at', cutoff)
    .limit(100)
  if (error) {
    console.error('[swap-nonce-recovery] findUnresolvedSwapAttempts failed:', error.message)
    return []
  }
  const out: UnresolvedSwapAttempt[] = []
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    out.push({
      id: r.id as string,
      intentId: r.intent_id as string,
      chainId: r.chain_id as string,
      walletAddress: r.wallet_address as string,
      nonce: Number(r.nonce),
      createdAt: r.created_at as string,
      expectedTo: KIT_ADAPTER_CONTRACT,
    })
  }
  return out
}

export function makeLiveSwapBlockFetcher(rpcs: string[]): BlockFetcher {
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

export function makeLiveSwapAttemptUpdateRepository(supabase: SupabaseClient) {
  return {
    async markSubmitted(attemptId: string, txHash: string): Promise<void> {
      const { error } = await supabase
        .from('transaction_attempts')
        .update({ tx_hash: txHash, status: 'SUBMITTED', submitted_at: new Date().toISOString() })
        .eq('id', attemptId)
      if (error) console.error('[swap-nonce-recovery] markSubmitted failed:', error.message)
    },
    async markReplaced(attemptId: string, _replacementTxHash: string): Promise<void> {
      const { error } = await supabase
        .from('transaction_attempts')
        .update({ status: 'REPLACED' })
        .eq('id', attemptId)
      if (error) console.error('[swap-nonce-recovery] markReplaced failed:', error.message)
    },
    async transitionIntentToFailed(intentId: string): Promise<void> {
      const { error } = await supabase
        .from('transaction_intents')
        .update({ status: 'FAILED', completed_at: new Date().toISOString() })
        .eq('id', intentId)
        .eq('status', 'SUBMITTED')
      if (error) console.error('[swap-nonce-recovery] transitionIntentToFailed failed:', error.message)
    },
  }
}
