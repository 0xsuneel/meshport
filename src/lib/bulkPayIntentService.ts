/**
 * bulkPayIntentService.ts — client for BulkPay's transaction_intent/attempt
 * lifecycle (docs/BULKPAY_TRANSACTION_INTENT_IMPLEMENTATION.md).
 *
 * Mirrors claimService.ts's own shape: this file POSTs to the
 * `bulkpay-intent` Edge Function, which does the actual server-side
 * writes (transaction_intents/transaction_attempts are REVOKE ALL FROM
 * anon, authenticated -- a direct client insert is impossible, confirmed in
 * docs/BULKPAY_TRANSACTION_INTENT_MIGRATION_AUDIT.md Question A).
 *
 * Two calls, both required by BulkPayoutPage.tsx's executePayout, in this
 * order:
 *   1. createBulkPayIntent -- BEFORE building the Multicall3 call. Returns
 *      the server-issued nonce, which MUST be used for the broadcast (never
 *      a client-computed one -- docs/BULKPAY_BROADCAST_RESPONSE_LOSS_AUDIT.md).
 *   2. markBulkPayAttemptSubmitted -- IMMEDIATELY after sendTransaction
 *      returns, BEFORE waitForTransactionReceipt. Persists the real
 *      tx_hash server-side so it survives a lost process (tab close,
 *      network loss), not just the local bulkTxHash variable fix already
 *      made directly in BulkPayoutPage.tsx.
 */
import { supabase, ensureAnonSession } from './supabase'
import { describeFunctionsError } from './describeFunctionsError'

export interface CreateBulkPayIntentResult {
  success: boolean
  intentId?: string
  attemptId?: string
  nonce?: number
  error?: string
}

export async function createBulkPayIntent(params: {
  walletAddress: string
  idempotencyKey: string
  chainId: string
  amountAtomic: string
  decimals: number
  isNative: boolean
  tokenAddress: string | null
  tokenSymbol: string | null
  recipientCount: number
  purpose?: string | null
}): Promise<CreateBulkPayIntentResult> {
  try {
    await ensureAnonSession()
    const { data, error } = await supabase.functions.invoke('bulkpay-intent', { body: params })
    // BUG FIX: see describeFunctionsError.ts — same class of bug traced live
    // from a Swap failure ("Edge Function returned a non-2xx status code"
    // shown instead of the real validation reason).
    if (error) return { success: false, error: await describeFunctionsError(error, 'Failed to create BulkPay intent') }
    if (!data?.success) return { success: false, error: data?.error ?? 'Failed to create BulkPay intent' }
    return { success: true, intentId: data.intentId, attemptId: data.attemptId, nonce: data.nonce }
  } catch (e: any) {
    return { success: false, error: e?.message ?? 'Failed to create BulkPay intent' }
  }
}

/**
 * Best-effort -- deliberately does not throw or block the caller's own
 * receipt-wait flow. If this call itself fails (network blip calling our
 * own server, distinct from the wallet broadcast itself), the LOCAL
 * bulkTxHash fix already in BulkPayoutPage.tsx still protects the
 * in-process value; only the server-side durability (surviving a lost tab)
 * would be missed for this one attempt, not the broadcast itself, which
 * already succeeded independently of this call.
 */
export async function markBulkPayAttemptSubmitted(attemptId: string, txHash: string): Promise<{ success: boolean; error?: string }> {
  try {
    await ensureAnonSession()
    const { data, error } = await supabase.functions.invoke('bulkpay-intent', {
      body: { action: 'markSubmitted', attemptId, txHash },
    })
    if (error) return { success: false, error: await describeFunctionsError(error, 'Failed to persist tx_hash') }
    if (!data?.success) return { success: false, error: data?.error ?? 'Failed to persist tx_hash' }
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message ?? 'Failed to persist tx_hash' }
  }
}
