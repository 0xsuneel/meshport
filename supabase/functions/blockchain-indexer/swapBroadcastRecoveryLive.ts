// supabase/functions/blockchain-indexer/swapBroadcastRecoveryLive.ts
//
// Real, live implementations for swapBroadcastRecovery.ts. Mirrors
// swapNonceRecoveryLive.ts's own shape, reusing the same KIT_ADAPTER_CONTRACT
// constant swapConfirmationLive.ts uses, and the same rpcCallRace helper
// every other live-wiring module in this directory uses.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { rpcCallRace } from './scanner.ts'
import { KIT_ADAPTER_CONTRACT } from './swapConfirmationLive.ts'
import type {
  BroadcastRecoveryCandidateFinder,
  BroadcastRecoveryUpdateRepository,
  BroadcastVerifier,
  CandidateChainEvent,
  RawTransactionForBroadcastVerify,
  UnresolvedSwapAttemptForBroadcastRecovery,
} from './swapBroadcastRecovery.ts'

/**
 * Finds swap attempts eligible for broadcast-loss recovery: CREATED,
 * tx_hash still NULL, and older than `graceMinutes` -- deliberately a much
 * longer grace period than swapNonceRecovery's own 5-minute default, so
 * this sweep never fights with or duplicates that cheaper, faster check;
 * it only ever looks at attempts nonce-recovery has already had many
 * chances to resolve and could not.
 */
export async function findUnresolvedSwapAttemptsForBroadcastRecovery(
  supabase: SupabaseClient,
  chainId: string,
  graceMinutes: number,
): Promise<UnresolvedSwapAttemptForBroadcastRecovery[]> {
  const cutoff = new Date(Date.now() - graceMinutes * 60_000).toISOString()
  const { data, error } = await supabase
    .from('transaction_attempts')
    .select('id, intent_id, chain_id, wallet_address, created_at, transaction_intents!inner(feature)')
    .eq('chain_id', chainId)
    .eq('status', 'CREATED')
    .eq('transaction_intents.feature', 'swap')
    .is('tx_hash', null)
    .not('wallet_address', 'is', null)
    .lt('created_at', cutoff)
    .limit(50)
  if (error) {
    console.error('[swap-broadcast-recovery] findUnresolvedSwapAttemptsForBroadcastRecovery failed:', error.message)
    return []
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map(r => ({
    id: r.id as string,
    intentId: r.intent_id as string,
    chainId: r.chain_id as string,
    walletAddress: r.wallet_address as string,
    createdAt: r.created_at as string,
  }))
}

export function makeLiveBroadcastRecoveryCandidateFinder(supabase: SupabaseClient): BroadcastRecoveryCandidateFinder {
  return {
    async findCandidates(attempt, windowMinutes, kitAdapterContract): Promise<CandidateChainEvent[]> {
      const wallet = attempt.walletAddress.toLowerCase()
      const kitAdapter = kitAdapterContract.toLowerCase()
      const windowEndIso = new Date(new Date(attempt.createdAt).getTime() + windowMinutes * 60_000).toISOString()

      // Candidate chain_events: this wallet's own confirmed
      // deposit_detected/transfer_detected rows, within the bounded window
      // after this attempt was created. Sender filtering (Kit Adapter
      // Contract only) and "not already claimed by another swap attempt"
      // happen below in plain JS rather than as a jsonb-in-SQL filter --
      // the `metadata` column's sender key varies by event_type
      // (`sender` for native-transfer-log rows, `from` for ERC20 rows, see
      // scanner.ts/decodeTransferLog.ts), and the anti-claim check needs a
      // second query anyway, so doing both here keeps the SQL simple and
      // the actual safety logic in one visible place.
      const { data: events, error } = await supabase
        .from('chain_events')
        .select('tx_hash, created_at, metadata')
        .eq('chain_id', attempt.chainId)
        .eq('wallet_address', wallet)
        .eq('status', 'confirmed')
        .in('event_type', ['deposit_detected', 'transfer_detected'])
        .gte('created_at', attempt.createdAt)
        .lte('created_at', windowEndIso)
        .not('tx_hash', 'is', null)
        .limit(20)
      if (error) {
        console.error('[swap-broadcast-recovery] findCandidates chain_events query failed:', error.message)
        return []
      }

      const senderMatched = ((events ?? []) as Array<Record<string, unknown>>).filter(e => {
        const meta = e.metadata as Record<string, unknown> | null
        const sender = (meta?.sender ?? meta?.from) as string | undefined
        return typeof sender === 'string' && sender.toLowerCase() === kitAdapter
      })
      if (senderMatched.length === 0) return []

      // Never accidentally claim another attempt's evidence: drop any
      // candidate tx_hash that already belongs to a DIFFERENT swap
      // transaction_attempts row (e.g. it was already resolved by
      // nonce-recovery, by api/swap-proxy.js's own server-side persistence,
      // or by a previous run of this very sweep for a different attempt).
      const candidateHashes = senderMatched.map(e => (e.tx_hash as string).toLowerCase())
      const { data: claimed, error: claimedErr } = await supabase
        .from('transaction_attempts')
        .select('tx_hash')
        .in('tx_hash', candidateHashes)
      if (claimedErr) {
        console.error('[swap-broadcast-recovery] findCandidates claimed-check failed:', claimedErr.message)
        return []
      }
      const claimedSet = new Set(((claimed ?? []) as Array<{ tx_hash: string | null }>).map(r => (r.tx_hash ?? '').toLowerCase()))

      return senderMatched
        .filter(e => !claimedSet.has((e.tx_hash as string).toLowerCase()))
        .map(e => ({ txHash: e.tx_hash as string, createdAt: e.created_at as string }))
    },
  }
}

export function makeLiveBroadcastVerifier(rpcs: string[]): BroadcastVerifier {
  return {
    async getTransaction(_chainId, txHash) {
      const result = await rpcCallRace(rpcs, 'eth_getTransactionByHash', [txHash])
      return (result ?? null) as RawTransactionForBroadcastVerify | null
    },
  }
}

export function makeLiveBroadcastRecoveryUpdateRepository(supabase: SupabaseClient): BroadcastRecoveryUpdateRepository {
  return {
    async markSubmitted(attemptId, txHash) {
      const { error } = await supabase
        .from('transaction_attempts')
        .update({ tx_hash: txHash.toLowerCase(), status: 'SUBMITTED', submitted_at: new Date().toISOString() })
        .eq('id', attemptId)
        .eq('status', 'CREATED')
        .is('tx_hash', null)
      if (error) console.error('[swap-broadcast-recovery] markSubmitted failed:', error.message)
    },
  }
}

export { KIT_ADAPTER_CONTRACT }
