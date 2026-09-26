// supabase/functions/blockchain-indexer/payConfirmationLive.ts
//
// Real, live implementations for Pay confirmation (payConfirmation.ts).
// Mirrors bulkpayConfirmationLive.ts's own shape, with the one real
// difference: findSubmittedAttempts computes `expectedTo` from the
// correlated intent (feature='pay' only) instead of a hardcoded constant.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { rpcCallRace } from './scanner.ts'
import type { ConfirmationUpdateRepository, ConfirmableAttempt, RawTransaction, RawTxReceipt, TransactionVerifier } from './payConfirmation.ts'

export async function findSubmittedAttempts(
  supabase: SupabaseClient,
  chainId: string,
): Promise<ConfirmableAttempt[]> {
  const { data, error } = await supabase
    .from('transaction_attempts')
    .select('id, intent_id, chain_id, wallet_address, nonce, tx_hash, transaction_intents!inner(feature, token_address, recipient_address)')
    .eq('chain_id', chainId)
    .in('status', ['SUBMITTED', 'CONFIRMING'])
    .eq('transaction_intents.feature', 'pay')
    .not('tx_hash', 'is', null)
    .not('nonce', 'is', null)
    .not('wallet_address', 'is', null)
    .limit(100)
  if (error) {
    console.error('[pay-confirmation] findSubmittedAttempts failed:', error.message)
    return []
  }
  const out: ConfirmableAttempt[] = []
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const intent = (r.transaction_intents as { token_address: string | null; recipient_address: string | null } | null)
    const expectedTo = intent?.token_address ?? intent?.recipient_address ?? null
    if (!expectedTo) {
      console.error(`[pay-confirmation] attempt ${r.id} skipped: intent has neither token_address nor recipient_address, cannot compute expectedTo`)
      continue
    }
    out.push({
      id: r.id as string,
      intentId: r.intent_id as string,
      chainId: r.chain_id as string,
      walletAddress: r.wallet_address as string,
      nonce: Number(r.nonce),
      txHash: r.tx_hash as string,
      expectedTo,
    })
  }
  return out
}

export function makeLiveTransactionVerifier(rpcs: string[]): TransactionVerifier {
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

export function makeLiveConfirmationUpdateRepository(supabase: SupabaseClient): ConfirmationUpdateRepository {
  return {
    async markConfirmed(attemptId, blockNumber) {
      const { error } = await supabase
        .from('transaction_attempts')
        .update({ status: 'CONFIRMED', confirmed_at: new Date().toISOString(), block_number: blockNumber })
        .eq('id', attemptId)
        .in('status', ['SUBMITTED', 'CONFIRMING'])
      if (error) console.error('[pay-confirmation] markConfirmed failed:', error.message)
    },
    async markReverted(attemptId) {
      const { error } = await supabase
        .from('transaction_attempts')
        .update({ status: 'REVERTED' })
        .eq('id', attemptId)
        .in('status', ['SUBMITTED', 'CONFIRMING'])
      if (error) console.error('[pay-confirmation] markReverted failed:', error.message)
    },
    async clearForRecovery(attemptId) {
      const { error } = await supabase
        .from('transaction_attempts')
        .update({ status: 'CREATED', tx_hash: null })
        .eq('id', attemptId)
        .in('status', ['SUBMITTED', 'CONFIRMING'])
      if (error) console.error('[pay-confirmation] clearForRecovery failed:', error.message)
    },
    async transitionIntent(intentId, to) {
      const { error } = await supabase
        .from('transaction_intents')
        .update({ status: to, completed_at: new Date().toISOString() })
        .eq('id', intentId)
        .eq('status', 'SUBMITTED')
      if (error) console.error('[pay-confirmation] transitionIntent failed:', error.message)
    },
  }
}
