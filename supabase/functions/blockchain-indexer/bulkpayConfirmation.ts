// supabase/functions/blockchain-indexer/bulkpayConfirmation.ts
//
// Canonical BulkPay confirmation (Phase 4, docs/BULKPAY_TRANSACTION_INTENT_IMPLEMENTATION.md).
//
// ── Architecture decision: B, not A ──────────────────────────────────────
// The frontend's own waitForTransactionReceipt observation is NEVER
// sufficient to move an attempt to CONFIRMED/REVERTED on its own -- this
// module (a server-side sweep, mirroring bulkpayNonceRecovery.ts's own
// shape exactly) independently re-fetches and re-verifies the real
// transaction and its real receipt before ever transitioning state. The
// frontend's role, unchanged from Phase 3, is only to persist tx_hash
// early (markBulkPayAttemptSubmitted) -- never to report an outcome that
// gets trusted directly. A frontend that lies, is compromised, or is simply
// wrong about what it observed cannot move an attempt to CONFIRMED by
// itself under this design, by construction, not by convention.
//
// ── The checks required before CONFIRMED, all independently verified ─────
// chain_id (implicit -- every fetch is scoped to attempt.chainId), tx_hash
// (attempt.txHash, already persisted), the transaction actually exists,
// transaction.to === Multicall3, transaction.nonce === attempt.nonce, and
// receipt.status indicates success. Any mismatch on sender/nonce/to is
// treated as a `mismatch` outcome -- NOT confirmed, NOT immediately
// reverted either (see mismatch handling below) -- the attempt's tx_hash
// is cleared so the ALREADY-BUILT nonce-recovery mechanism
// (bulkpayNonceRecovery.ts) picks it up on its own next pass and correctly
// re-derives the real transaction (or REPLACED, or DROPPED) using its own,
// already-proven, `to`-verified logic -- this module does not duplicate
// that decision, it defers to it.

const MULTICALL3_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11'

export interface ConfirmableAttempt {
  id: string
  intentId: string
  chainId: string
  walletAddress: string
  nonce: number
  txHash: string
}

export interface RawTransaction {
  hash: string
  from: string
  to: string | null
  nonce: string
}

export interface RawTxReceipt {
  status: string
  blockNumber: string
}

export interface TransactionVerifier {
  getTransaction(chainId: string, txHash: string): Promise<RawTransaction | null>
  getReceipt(chainId: string, txHash: string): Promise<RawTxReceipt | null>
}

export type ConfirmationOutcome =
  | { outcome: 'confirmed'; blockNumber: number }
  | { outcome: 'reverted' }
  | { outcome: 'pending' }
  | { outcome: 'missing' }
  | { outcome: 'mismatch'; reason: string }

/**
 * Independently verifies one attempt's already-persisted tx_hash against
 * the real chain. Never broadcasts anything, never trusts any
 * client-reported outcome -- every field checked here comes from a fresh
 * RPC read.
 */
export async function verifyAttemptConfirmation(
  verifier: TransactionVerifier,
  attempt: ConfirmableAttempt,
): Promise<ConfirmationOutcome> {
  const tx = await verifier.getTransaction(attempt.chainId, attempt.txHash)
  if (!tx) return { outcome: 'missing' }

  const from = (tx.from ?? '').toLowerCase()
  if (from !== attempt.walletAddress.toLowerCase()) {
    return { outcome: 'mismatch', reason: `transaction sender ${from} does not match attempt wallet ${attempt.walletAddress}` }
  }

  let txNonce: number
  try { txNonce = Number(BigInt(tx.nonce)) } catch {
    return { outcome: 'mismatch', reason: 'transaction nonce could not be parsed' }
  }
  if (txNonce !== attempt.nonce) {
    return { outcome: 'mismatch', reason: `transaction nonce ${txNonce} does not match attempt nonce ${attempt.nonce}` }
  }

  const to = (tx.to ?? '').toLowerCase()
  if (to !== MULTICALL3_ADDRESS) {
    return { outcome: 'mismatch', reason: `transaction.to ${to} is not Multicall3` }
  }

  const receipt = await verifier.getReceipt(attempt.chainId, attempt.txHash)
  if (!receipt) return { outcome: 'pending' }
  if (receipt.status === '0x1') {
    let blockNumber: number
    try { blockNumber = Number(BigInt(receipt.blockNumber)) } catch { blockNumber = 0 }
    return { outcome: 'confirmed', blockNumber }
  }
  return { outcome: 'reverted' }
}

// ── Orchestration ────────────────────────────────────────────────────────

export interface ConfirmationUpdateRepository {
  markConfirmed(attemptId: string, blockNumber: number): Promise<void>
  markReverted(attemptId: string): Promise<void>
  clearForRecovery(attemptId: string): Promise<void>
  /**
   * Transitions the parent transaction_intent SUBMITTED -> CONFIRMED or
   * SUBMITTED -> FAILED, mirroring the attempt's own terminal outcome.
   * Without this, transaction_intents.status stays at 'SUBMITTED' forever
   * even after the attempt fully confirms/reverts -- deriveDisplayState
   * would then perpetually show "SUBMITTED" instead of the real outcome.
   */
  transitionIntent(intentId: string, to: 'CONFIRMED' | 'FAILED'): Promise<void>
}

export interface ConfirmationResult {
  attemptId: string
  outcome: ConfirmationOutcome['outcome']
}

/**
 * Sweeps attempts in SUBMITTED/CONFIRMING with a real tx_hash and
 * independently verifies + transitions each. Never broadcasts anything.
 * One attempt's failure (RPC error, etc.) does not abort the rest of the
 * sweep. `pending`/`missing` outcomes leave the attempt completely
 * untouched (Requirements 5/6 -- RPC timeout and a not-yet-visible
 * transaction must both remain recoverable, never treated as failure).
 */
export async function sweepSubmittedAttempts(
  attempts: ConfirmableAttempt[],
  verifier: TransactionVerifier,
  updateRepo: ConfirmationUpdateRepository,
): Promise<ConfirmationResult[]> {
  const results: ConfirmationResult[] = []
  for (const attempt of attempts) {
    try {
      const outcome = await verifyAttemptConfirmation(verifier, attempt)
      if (outcome.outcome === 'confirmed') {
        await updateRepo.markConfirmed(attempt.id, outcome.blockNumber)
        await updateRepo.transitionIntent(attempt.intentId, 'CONFIRMED')
      } else if (outcome.outcome === 'reverted') {
        await updateRepo.markReverted(attempt.id)
        await updateRepo.transitionIntent(attempt.intentId, 'FAILED')
      } else if (outcome.outcome === 'mismatch') {
        await updateRepo.clearForRecovery(attempt.id)
      }
      results.push({ attemptId: attempt.id, outcome: outcome.outcome })
    } catch (e) {
      console.error(`[bulkpay-confirmation] attempt ${attempt.id} failed:`, e instanceof Error ? e.message : e)
      results.push({ attemptId: attempt.id, outcome: 'missing' })
    }
  }
  return results
}
