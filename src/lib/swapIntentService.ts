/**
 * swapIntentService.ts -- client for Swap's transaction_intent/attempt
 * lifecycle. Mirrors payIntentService.ts's own shape exactly (the same
 * production-validated pattern), applied to Swap.
 *
 * ── A real, disclosed constraint on `nonce` (read before relying on it) ──
 * Pay/BulkPay construct their own raw transaction and pass the reserved
 * nonce to the signer explicitly -- the nonce this service returns is
 * genuinely the one that gets broadcast. Swap does not: swap-proxy.js
 * calls Circle's AppKit `kit.swap()`, whose SwapParams/SwapConfig (verified
 * directly against the published @circle-fin/swap-kit@1.0.0 type
 * definitions -- no `nonce` field exists anywhere on SwapParams or
 * SwapConfig) gives no way to supply an external nonce. The SDK owns nonce
 * allocation internally via its own process-local EthersNonceManager,
 * re-querying the provider's pending nonce at execution time, and may
 * broadcast MORE than one transaction per swap() call (an approve
 * transaction, if the permit path isn't available for this token, before
 * the swap transaction itself) -- so "one swap = one nonce" is not even
 * structurally guaranteed the way it is for Pay/BulkPay's own
 * single-transaction sends.
 *
 * So `nonce` here is a best-effort, informational snapshot (the wallet's
 * pending nonce at the moment the intent was created) for operational
 * visibility and DB-shape parity with Pay/BulkPay -- NOT a hard broadcast-
 * time reservation the way it is for those two features, and it must never
 * be treated as one. The real anti-double-broadcast protection for Swap is
 * (and remains) swap-proxy.js's own `verifySwapLanded` chain-state check
 * and its `isUncertain`-gated retry-skip, which do not depend on nonce
 * matching at all. This is disclosed here rather than papered over with
 * nonce-reservation machinery that could not actually be enforced given
 * this SDK boundary.
 */
import { supabase, ensureAnonSession } from './supabase'
import { describeFunctionsError } from './describeFunctionsError'

export interface CreateSwapIntentResult {
  success: boolean
  intentId?: string
  attemptId?: string
  nonce?: number
  error?: string
}

export async function createSwapIntent(params: {
  walletAddress: string
  idempotencyKey: string
  chainId: string
  amountInAtomic: string
  decimalsIn: number
  tokenInAddress: string | null
  tokenInSymbol: string | null
  isNativeIn: boolean
  tokenOutAddress: string | null
  tokenOutSymbol: string | null
  decimalsOut: number
  minAmountOutAtomic: string | null
  expectedAmountOutAtomic: string | null
  slippageBps: number | null
  routerAddress: string | null
}): Promise<CreateSwapIntentResult> {
  try {
    await ensureAnonSession()
    const { data, error } = await supabase.functions.invoke('swap-intent', { body: params })
    // BUG FIX: see describeFunctionsError.ts's own header comment — error.message
    // here used to always be the SDK's generic "Edge Function returned a
    // non-2xx status code", hiding the real validation reason (e.g.
    // "walletAddress required") that swap-intent's own response body carried.
    if (error) return { success: false, error: await describeFunctionsError(error, 'Failed to create Swap intent') }
    if (!data?.success) return { success: false, error: data?.error ?? 'Failed to create Swap intent' }
    return { success: true, intentId: data.intentId, attemptId: data.attemptId, nonce: data.nonce }
  } catch (e: any) {
    return { success: false, error: e?.message ?? 'Failed to create Swap intent' }
  }
}

/**
 * Best-effort, mirrors markPayAttemptSubmitted -- never throws, never
 * blocks or fails the caller's own already-broadcast transaction. Called
 * immediately after a real txHash is observed, so tx_hash is persisted
 * without waiting for a receipt (per the architecture's own "do NOT wait
 * for receipt before persisting tx_hash" rule).
 */
export async function markSwapAttemptSubmitted(attemptId: string, txHash: string): Promise<{ success: boolean; error?: string }> {
  try {
    await ensureAnonSession()
    const { data, error } = await supabase.functions.invoke('swap-intent', {
      body: { action: 'markSubmitted', attemptId, txHash },
    })
    if (error) return { success: false, error: await describeFunctionsError(error, 'Failed to persist tx_hash') }
    if (!data?.success) return { success: false, error: data?.error ?? 'Failed to persist tx_hash' }
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message ?? 'Failed to persist tx_hash' }
  }
}
