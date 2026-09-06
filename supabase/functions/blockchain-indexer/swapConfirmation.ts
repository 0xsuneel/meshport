// supabase/functions/blockchain-indexer/swapConfirmation.ts
//
// Canonical Swap confirmation. Same architecture as payConfirmation.ts /
// bulkpayConfirmation.ts (both already production-validated) -- a sibling,
// not a modification to either.
//
// ── The real differences from payConfirmation.ts ──────────────────────────
// Pay's `to` is the recipient wallet (native) or the token contract
// (ERC20). Swap's `to` is always the Kit Adapter Contract (the router the
// swap transaction is broadcast to) -- a fixed, known-internal-contract
// address (see supabase/functions/_shared/knownInternalContracts.ts),
// analogous to how BulkPay's `to` is always the fixed Multicall3 constant.
// expectedTo is still threaded through as an explicit field (not hardcoded
// in this file) so the live wiring layer stays the single place that reads
// the constant, exactly like payConfirmationLive.ts/bulkpayConfirmationLive.ts.
//
// Second, deliberate difference: this file does NOT check `tx.nonce ===
// attempt.nonce`, unlike Pay/BulkPay's confirmation. Pay/BulkPay construct
// their own raw transaction and pass the reserved nonce to the signer
// directly, so their stored nonce is authoritative and a mismatch is a
// real signal (a replacement transaction). Swap's stored nonce is
// informational only -- swap-proxy.js never references `nonce` at all;
// Circle's Kit SDK allocates the real broadcast nonce internally (see
// swapBroadcastRecovery.ts's header for the full root-cause writeup, and
// SwapPage.tsx's own comment on the disclosed nonce). This was previously
// a latent bug: a real, correctly-verified swap recovered by
// swap-broadcast-recovery (sender==wallet, to==Kit Adapter Contract, both
// independently re-verified via RPC) was being incorrectly bounced back to
// CREATED by this file's nonce check, undoing the recovery every time it
// ran. The sender+to checks below are the same trust bar
// swapBroadcastRecovery.ts's own independent verification already uses --
// removing the nonce check here doesn't weaken anything, it just stops
// applying a check that was never meaningful for Swap in the first place.

export interface ConfirmableSwapAttempt {
  id: string
  intentId: string
  chainId: string
  walletAddress: string
  nonce: number
  txHash: string
  expectedTo: string
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

export type SwapConfirmationOutcome =
  | { outcome: 'confirmed'; blockNumber: number }
  | { outcome: 'reverted' }
  | { outcome: 'pending' }
  | { outcome: 'missing' }
  | { outcome: 'mismatch'; reason: string }

export async function verifySwapAttemptConfirmation(
  verifier: TransactionVerifier,
  attempt: ConfirmableSwapAttempt,
): Promise<SwapConfirmationOutcome> {
  const tx = await verifier.getTransaction(attempt.chainId, attempt.txHash)
  if (!tx) return { outcome: 'missing' }

  const from = (tx.from ?? '').toLowerCase()
  if (from !== attempt.walletAddress.toLowerCase()) {
    return { outcome: 'mismatch', reason: `transaction sender ${from} does not match attempt wallet ${attempt.walletAddress}` }
  }

  // No nonce check here -- see this file's header for why (Swap's stored
  // nonce is informational only, unlike Pay/BulkPay's).

  const to = (tx.to ?? '').toLowerCase()
  if (to !== attempt.expectedTo.toLowerCase()) {
    return { outcome: 'mismatch', reason: `transaction.to ${to} does not match expected Kit Adapter address ${attempt.expectedTo}` }
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

export interface SwapConfirmationUpdateRepository {
  markConfirmed(attemptId: string, blockNumber: number): Promise<void>
  markReverted(attemptId: string): Promise<void>
  clearForRecovery(attemptId: string): Promise<void>
  transitionIntent(intentId: string, to: 'CONFIRMED' | 'FAILED'): Promise<void>
}

export interface SwapConfirmationResult {
  attemptId: string
  outcome: SwapConfirmationOutcome['outcome']
}

/**
 * Sweeps SUBMITTED/CONFIRMING swap attempts. On 'confirmed', this is the
 * point at which classifySwapDebit (server/ledger/classifiers.ts) becomes
 * applicable -- the interpreter reads CONFIRMED attempts directly for
 * SWAP_DEBIT, no chain_event required for that leg. SWAP_CREDIT still
 * depends on swapReconcile.ts independently decoding the Kit Adapter's
 * outbound Transfer log, run separately.
 */
export async function sweepSubmittedSwapAttempts(
  attempts: ConfirmableSwapAttempt[],
  verifier: TransactionVerifier,
  updateRepo: SwapConfirmationUpdateRepository,
): Promise<SwapConfirmationResult[]> {
  const results: SwapConfirmationResult[] = []
  for (const attempt of attempts) {
    try {
      const outcome = await verifySwapAttemptConfirmation(verifier, attempt)
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
      console.error(`[swap-confirmation] attempt ${attempt.id} failed:`, e instanceof Error ? e.message : e)
      results.push({ attemptId: attempt.id, outcome: 'missing' })
    }
  }
  return results
}
