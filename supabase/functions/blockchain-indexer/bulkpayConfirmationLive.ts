// supabase/functions/blockchain-indexer/bulkpayConfirmationLive.ts
//
// Real, live implementations for BulkPay confirmation
// (bulkpayConfirmation.ts) -- the only place in this feature that touches
// a real Supabase client or makes a real RPC call. Mirrors
// bulkpayNonceRecoveryLive.ts's own shape exactly.
//
// ── Why this doesn't import server/transactionStateMachine/apply.ts ────────
// transitionAttempt (the Node-side, already-proven, conditional-UPDATE
// transition function) is exactly the right semantics for these writes,
// but it is written for Node's @supabase/supabase-js bare-specifier import,
// not directly importable into this Deno function (the same cross-runtime
// boundary already documented in server/ledger/classifiers.ts's own
// disclosed-third-copy decision for knownInternalContracts). The functions
// below MIRROR transitionAttempt's core guarantee -- a conditional
// UPDATE ... WHERE id = $1 AND status IN (...), so a concurrent duplicate
// call is a safe no-op rather than a race -- using Deno's own Supabase
// client, rather than importing the Node module directly.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { rpcCallRace } from './scanner.ts'
import type { ConfirmationUpdateRepository, ConfirmableAttempt, RawTransaction, RawTxReceipt, TransactionVerifier } from './bulkpayConfirmation.ts'

/** Reads transaction_attempts rows in SUBMITTED/CONFIRMING with a real tx_hash -- exactly the population Phase 4 needs to verify. */
export async function findSubmittedAttempts(
  supabase: SupabaseClient,
  chainId: string,
): Promise<ConfirmableAttempt[]> {
  const { data, error } = await supabase
    .from('transaction_attempts')
    .select('id, intent_id, chain_id, wallet_address, nonce, tx_hash, transaction_intents!inner(feature)')
    .eq('chain_id', chainId)
    .in('status', ['SUBMITTED', 'CONFIRMING'])
    .eq('transaction_intents.feature', 'bulkpay')
    .not('tx_hash', 'is', null)
    .not('nonce', 'is', null)
    .not('wallet_address', 'is', null)
    .limit(100)
  if (error) {
    console.error('[bulkpay-confirmation] findSubmittedAttempts failed:', error.message)
    return []
  }
  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    intentId: r.intent_id as string,
    chainId: r.chain_id as string,
    walletAddress: r.wallet_address as string,
    nonce: Number(r.nonce),
    txHash: r.tx_hash as string,
  }))
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

/**
 * Mirrors transitionAttempt's conditional-UPDATE guarantee: only writes if
 * the row is currently in one of the states this transition is valid from.
 * A concurrent duplicate call becomes a safe no-op rather than an error.
 */
export function makeLiveConfirmationUpdateRepository(supabase: SupabaseClient): ConfirmationUpdateRepository {
  return {
    async markConfirmed(attemptId, blockNumber) {
      const { error } = await supabase
        .from('transaction_attempts')
        .update({ status: 'CONFIRMED', confirmed_at: new Date().toISOString(), block_number: blockNumber })
        .eq('id', attemptId)
        .in('status', ['SUBMITTED', 'CONFIRMING'])
      if (error) console.error('[bulkpay-confirmation] markConfirmed failed:', error.message)
    },
    async markReverted(attemptId) {
      const { error } = await supabase
        .from('transaction_attempts')
        .update({ status: 'REVERTED' })
        .eq('id', attemptId)
        .in('status', ['SUBMITTED', 'CONFIRMING'])
      if (error) console.error('[bulkpay-confirmation] markReverted failed:', error.message)
    },
    async clearForRecovery(attemptId) {
      // Resets to CREATED with tx_hash cleared -- exactly the shape
      // bulkpayNonceRecoveryLive.ts's findUnresolvedAttempts already
      // queries for, so the existing, already-proven nonce-recovery sweep
      // picks this attempt up on its own next pass, no new worklist logic
      // needed.
      const { error } = await supabase
        .from('transaction_attempts')
        .update({ status: 'CREATED', tx_hash: null })
        .eq('id', attemptId)
        .in('status', ['SUBMITTED', 'CONFIRMING'])
      if (error) console.error('[bulkpay-confirmation] clearForRecovery failed:', error.message)
    },
    async transitionIntent(intentId, to) {
      // completed_at set for BOTH terminal outcomes -- it represents "this
      // intent's processing concluded", not "concluded successfully" (the
      // status column already carries success/failure). Real bug found and
      // fixed this session: this write previously only touched `status`,
      // leaving completed_at permanently NULL even for a genuinely finished
      // intent.
      const { error } = await supabase
        .from('transaction_intents')
        .update({ status: to, completed_at: new Date().toISOString() })
        .eq('id', intentId)
        .eq('status', 'SUBMITTED')
      if (error) console.error('[bulkpay-confirmation] transitionIntent failed:', error.message)
    },
  }
}
