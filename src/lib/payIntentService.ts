/**
 * payIntentService.ts -- client for Pay's transaction_intent/attempt
 * lifecycle. Mirrors bulkPayIntentService.ts's own shape exactly (the
 * same production-validated pattern), applied to Pay.
 */
import { ensureAnonSession, invokeLinked } from './supabase'
import { describeFunctionsError } from './describeFunctionsError'
import { assertAccountUnlocked } from '@/lib/accountLockRule'

export interface CreatePayIntentResult {
  success: boolean
  intentId?: string
  attemptId?: string
  nonce?: number
  /**
   * RESILIENCE FIX (2026-09-17): present only on an idempotent-replay
   * response where this exact payment (same wallet + idempotencyKey) was
   * already broadcast on a PREVIOUS attempt - e.g. the network dropped the
   * response before the client saw it, and the user retried. When this is
   * set, arcService.ts must treat the payment as already sent and return
   * success using THIS hash rather than signing/broadcasting again, which
   * would otherwise risk a genuine double-send.
   */
  existingTxHash?: string
  error?: string
}

/**
 * Warms the pay-intent Supabase Edge Function so the real payment call
 * doesn't pay a cold-start penalty. Called on PaySendPage and ChatPay
 * mount — long before the user hits Send — so the function is already
 * warm when it matters. Fire-and-forget; never throws; throttled to once
 * per 20s so a frequent page-mount loop can't spam it.
 *
 * The Edge Function's own /health route (or the cheap 'ping' action) keeps
 * the V8 isolate alive; cold-start time drops from ~500–1500ms to ~0ms on
 * the subsequent real call.
 */
let _lastWarmAt = 0
export async function warmPayIntent(): Promise<void> {
  if (Date.now() - _lastWarmAt < 20_000) return
  _lastWarmAt = Date.now()
  try {
    await ensureAnonSession()
    // 'ping' is a no-op action the Edge Function ignores gracefully,
    // costing only the cold-start wake without creating any DB rows.
    await invokeLinked('pay-intent', { action: 'ping' })
  } catch { /* warm-up failure is silent and harmless */ }
}

export async function createPayIntent(params: {
  walletAddress: string
  idempotencyKey: string
  chainId: string
  amountAtomic: string
  decimals: number
  isNative: boolean
  tokenAddress: string | null
  tokenSymbol: string | null
  recipientAddress: string
  recipientUsername?: string | null
  /** Set for an order payment sent through Arc's Memo contract. */
  callTarget?: string | null
}): Promise<CreatePayIntentResult> {
  assertAccountUnlocked() // business not approved yet: nothing moves
  try {
    await ensureAnonSession()
    const { data, error } = await invokeLinked('pay-intent', params as Record<string, unknown>)
    // BUG FIX: see describeFunctionsError.ts - error.message here used to
    // always be the SDK's generic "Edge Function returned a non-2xx status
    // code", hiding the real validation reason pay-intent's own response
    // body carried (same class of bug traced live from a Swap failure).
    if (error) return { success: false, error: await describeFunctionsError(error, 'Failed to create Pay intent') }
    if (!data?.success) return { success: false, error: data?.error ?? 'Failed to create Pay intent' }
    // RESILIENCE FIX (2026-09-17): an idempotent_replay response carries
    // nonce and/or txHash (see logic.ts's own comment on that outcome
    // variant) instead of always meaning "this key was already used, fail."
    // A present tx_hash means the original attempt actually broadcast -
    // surface it as existingTxHash so the caller can resume by returning
    // success directly. A present nonce with no tx_hash means the
    // reservation exists but never broadcast - safe to hand back the SAME
    // nonce so the caller continues the original attempt instead of
    // erroring or (worse) creating a second reservation.
    return { success: true, intentId: data.intentId, attemptId: data.attemptId, nonce: data.nonce, existingTxHash: data.txHash ?? undefined }
  } catch (e: any) {
    return { success: false, error: e?.message ?? 'Failed to create Pay intent' }
  }
}

/**
 * Best-effort, mirrors markBulkPayAttemptSubmitted -- never throws, never
 * blocks or fails the caller's own already-broadcast transaction.
 */
export async function markPayAttemptSubmitted(attemptId: string, txHash: string): Promise<{ success: boolean; error?: string }> {
  try {
    await ensureAnonSession()
    const { data, error } = await invokeLinked('pay-intent', { action: 'markSubmitted', attemptId, txHash })
    if (error) return { success: false, error: await describeFunctionsError(error, 'Failed to persist tx_hash') }
    if (!data?.success) return { success: false, error: data?.error ?? 'Failed to persist tx_hash' }
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message ?? 'Failed to persist tx_hash' }
  }
}
