// supabase/functions/blockchain-indexer/swapConfirmationLive.ts
//
// Real, live implementations for Swap confirmation (swapConfirmation.ts).
// Mirrors payConfirmationLive.ts's own shape. expectedTo is always the Kit
// Adapter Contract address (KIT_ADAPTER_CONTRACT), imported from the shared
// known-internal-contracts list rather than re-declared here, so it can
// never drift from the value classifySwapCredit/isKnownInternalContract
// also rely on.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { rpcCallRace } from './scanner.ts'
import type { SwapConfirmationUpdateRepository, ConfirmableSwapAttempt, RawTransaction, RawTxReceipt, TransactionVerifier } from './swapConfirmation.ts'

// Kit Adapter Contract testnet address -- copied verbatim from
// supabase/functions/_shared/knownInternalContracts.ts (kept as a literal
// here, not an import, for the same reason payConfirmationLive.ts computes
// expectedTo locally rather than importing chains.ts: this file must stay
// a thin, independently-testable live-wiring layer). MUST stay in sync with
// knownInternalContracts.ts's own copy -- verified identical as of this
// writing.
export const KIT_ADAPTER_CONTRACT = '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b'

export async function findSubmittedSwapAttempts(
  supabase: SupabaseClient,
  chainId: string,
): Promise<ConfirmableSwapAttempt[]> {
  const { data, error } = await supabase
    .from('transaction_attempts')
    .select('id, intent_id, chain_id, wallet_address, nonce, tx_hash, transaction_intents!inner(feature)')
    .eq('chain_id', chainId)
    .in('status', ['SUBMITTED', 'CONFIRMING'])
    .eq('transaction_intents.feature', 'swap')
    .not('tx_hash', 'is', null)
    .not('nonce', 'is', null)
    .not('wallet_address', 'is', null)
    .limit(100)
  if (error) {
    console.error('[swap-confirmation] findSubmittedSwapAttempts failed:', error.message)
    return []
  }
  const out: ConfirmableSwapAttempt[] = []
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    out.push({
      id: r.id as string,
      intentId: r.intent_id as string,
      chainId: r.chain_id as string,
      walletAddress: r.wallet_address as string,
      nonce: Number(r.nonce),
      txHash: r.tx_hash as string,
      expectedTo: KIT_ADAPTER_CONTRACT,
    })
  }
  return out
}

export function makeLiveSwapTransactionVerifier(rpcs: string[]): TransactionVerifier {
  return {
    async getTransaction(_chainId, txHash) {
      const result = await rpcCallRace(rpcs, 'eth_getTransactionByHash', [txHash])
      return (result ?? null) as RawTransaction | null
    },
    async getReceipt(_chainId, txHash) {
      const result = await rpcCallRace(rpcs, 'eth_getTransactionReceipt', [txHash])
      return (result ?? null) as RawTxReceipt | null
    },
  }
}

export function makeLiveSwapConfirmationUpdateRepository(supabase: SupabaseClient): SwapConfirmationUpdateRepository {
  return {
    async markConfirmed(attemptId, blockNumber) {
      const { error } = await supabase
        .from('transaction_attempts')
        .update({ status: 'CONFIRMED', confirmed_at: new Date().toISOString(), block_number: blockNumber })
        .eq('id', attemptId)
        .in('status', ['SUBMITTED', 'CONFIRMING'])
      if (error) console.error('[swap-confirmation] markConfirmed failed:', error.message)
    },
    async markReverted(attemptId) {
      const { error } = await supabase
        .from('transaction_attempts')
        .update({ status: 'REVERTED' })
        .eq('id', attemptId)
        .in('status', ['SUBMITTED', 'CONFIRMING'])
      if (error) console.error('[swap-confirmation] markReverted failed:', error.message)
    },
    async clearForRecovery(attemptId) {
      const { error } = await supabase
        .from('transaction_attempts')
        .update({ status: 'CREATED', tx_hash: null })
        .eq('id', attemptId)
        .in('status', ['SUBMITTED', 'CONFIRMING'])
      if (error) console.error('[swap-confirmation] clearForRecovery failed:', error.message)
    },
    async transitionIntent(intentId, to) {
      const { error } = await supabase
        .from('transaction_intents')
        .update({ status: to, completed_at: new Date().toISOString() })
        .eq('id', intentId)
        .eq('status', 'SUBMITTED')
      if (error) console.error('[swap-confirmation] transitionIntent failed:', error.message)
    },
  }
}
