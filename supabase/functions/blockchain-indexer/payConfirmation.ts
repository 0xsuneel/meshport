// supabase/functions/blockchain-indexer/payConfirmation.ts
//
// Canonical Pay confirmation. Same architecture as bulkpayConfirmation.ts
// (already production-validated for BulkPay) -- deliberately NOT a shared
// module with it (BulkPay is explicitly out of scope for modification this
// task), a sibling following the identical, proven pattern instead.
//
// ── The one real difference from bulkpayConfirmation.ts ──────────────────
// BulkPay's `to` is always Multicall3, a fixed constant. Pay's `to` varies
// per transaction: the recipient's own wallet for a native transfer, or the
// token contract for an ERC20 transfer (see arcService.ts's sendUSDC vs
// sendEURC -- sendUSDC's `to` is the recipient directly; sendEURC's `to` is
// EURC_CONTRACT with the recipient encoded in the calldata). So
// ConfirmableAttempt carries an explicit `expectedTo`, computed by the live
// query from the correlated intent (token_address IS NULL -> recipient
// wallet; otherwise -> token_address) -- never hardcoded here.

export interface ConfirmableAttempt {
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

export type ConfirmationOutcome =
  | { outcome: 'confirmed'; blockNumber: number }
  | { outcome: 'reverted' }
  | { outcome: 'pending' }
  | { outcome: 'missing' }
  | { outcome: 'mismatch'; reason: string }

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
  if (to !== attempt.expectedTo.toLowerCase()) {
    return { outcome: 'mismatch', reason: `transaction.to ${to} does not match expected ${attempt.expectedTo}` }
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

export interface ConfirmationUpdateRepository {
  markConfirmed(attemptId: string, blockNumber: number): Promise<void>
  markReverted(attemptId: string): Promise<void>
  clearForRecovery(attemptId: string): Promise<void>
  transitionIntent(intentId: string, to: 'CONFIRMED' | 'FAILED'): Promise<void>
}

export interface ConfirmationResult {
  attemptId: string
  outcome: ConfirmationOutcome['outcome']
}

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
      console.error(`[pay-confirmation] attempt ${attempt.id} failed:`, e instanceof Error ? e.message : e)
      results.push({ attemptId: attempt.id, outcome: 'missing' })
    }
  }
  return results
}
