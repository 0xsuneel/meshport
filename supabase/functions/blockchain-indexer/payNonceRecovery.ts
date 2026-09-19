// supabase/functions/blockchain-indexer/payNonceRecovery.ts
//
// UNKNOWN/broadcast-response-loss recovery for Pay. Same architecture as
// bulkpayNonceRecovery.ts (already production-validated for BulkPay) --
// deliberately NOT a shared module with it (BulkPay is out of scope for
// modification this task), a sibling following the identical pattern.
//
// The one real difference: bulkpayNonceRecovery.ts's recoverAttemptByNonce
// hardcodes `to === MULTICALL3_ADDRESS` to decide confirmed vs replaced.
// Pay's expected `to` varies per transaction (recipient wallet for native,
// token contract for ERC20 -- see payConfirmation.ts's own header comment
// for the full reasoning), so it is threaded through as an explicit
// parameter here instead.

export interface UnresolvedAttempt {
  id: string
  intentId: string
  chainId: string
  walletAddress: string
  nonce: number
  createdAt: string
  expectedTo: string
}

export interface RawBlockWithTransactions {
  number: string
  transactions: Array<{
    hash: string
    from: string
    to: string | null
    nonce: string
  }>
}

export interface BlockFetcher {
  getBlockWithTransactions(chainId: string, blockNumber: number): Promise<RawBlockWithTransactions | null>
  getCurrentBlockNumber(chainId: string): Promise<number>
}

export type NonceRecoveryOutcome =
  | { outcome: 'confirmed'; txHash: string; blockNumber: number }
  | { outcome: 'replaced'; txHash: string }
  | { outcome: 'not_found' }

/**
 * Scans blocks newest-first for a transaction matching (wallet, nonce).
 * NEVER broadcasts anything -- only discovers or fails to discover an
 * already-mined transaction. A match whose `to` isn't this attempt's own
 * expectedTo is REPLACED, never silently accepted as confirmation.
 */
export async function recoverAttemptByNonce(
  fetcher: BlockFetcher,
  attempt: UnresolvedAttempt,
  fromBlockNumber: number,
  toBlockNumber: number,
): Promise<NonceRecoveryOutcome> {
  const wallet = attempt.walletAddress.trim().toLowerCase()
  const expectedTo = attempt.expectedTo.trim().toLowerCase()

  for (let bn = toBlockNumber; bn >= fromBlockNumber; bn--) {
    const block = await fetcher.getBlockWithTransactions(attempt.chainId, bn)
    if (!block) continue

    for (const tx of block.transactions) {
      if ((tx.from ?? '').toLowerCase() !== wallet) continue
      let txNonce: number
      try { txNonce = Number(BigInt(tx.nonce)) } catch { continue }
      if (txNonce !== attempt.nonce) continue

      const to = (tx.to ?? '').toLowerCase()
      if (to === expectedTo) {
        return { outcome: 'confirmed', txHash: tx.hash.toLowerCase(), blockNumber: bn }
      }
      return { outcome: 'replaced', txHash: tx.hash.toLowerCase() }
    }
  }

  return { outcome: 'not_found' }
}

export interface AttemptUpdateRepository {
  markSubmitted(attemptId: string, txHash: string): Promise<void>
  markReplaced(attemptId: string, replacementTxHash: string): Promise<void>
  transitionIntentToFailed(intentId: string): Promise<void>
}

export interface NonceRecoveryResult {
  attemptId: string
  outcome: NonceRecoveryOutcome['outcome']
  txHash?: string
}

/**
 * Sweeps unresolved Pay attempts (Case 2's signal: CREATED/BROADCASTING
 * with tx_hash IS NULL, older than the caller's grace period). Never
 * broadcasts. Byte-for-byte the same orchestration shape as
 * bulkpayNonceRecovery.ts's own sweepUnresolvedAttempts.
 */
export async function sweepUnresolvedAttempts(
  unresolvedAttempts: UnresolvedAttempt[],
  fetcher: BlockFetcher,
  updateRepo: AttemptUpdateRepository,
  scanWindowBlocks: number,
): Promise<NonceRecoveryResult[]> {
  const results: NonceRecoveryResult[] = []
  for (const attempt of unresolvedAttempts) {
    try {
      const currentBlock = await fetcher.getCurrentBlockNumber(attempt.chainId)
      const fromBlock = Math.max(0, currentBlock - scanWindowBlocks)
      const outcome = await recoverAttemptByNonce(fetcher, attempt, fromBlock, currentBlock)

      if (outcome.outcome === 'confirmed') {
        await updateRepo.markSubmitted(attempt.id, outcome.txHash)
        results.push({ attemptId: attempt.id, outcome: 'confirmed', txHash: outcome.txHash })
      } else if (outcome.outcome === 'replaced') {
        await updateRepo.markReplaced(attempt.id, outcome.txHash)
        await updateRepo.transitionIntentToFailed(attempt.intentId)
        results.push({ attemptId: attempt.id, outcome: 'replaced', txHash: outcome.txHash })
      } else {
        results.push({ attemptId: attempt.id, outcome: 'not_found' })
      }
    } catch (e) {
      console.error(`[pay-nonce-recovery] attempt ${attempt.id} failed:`, e instanceof Error ? e.message : e)
      results.push({ attemptId: attempt.id, outcome: 'not_found' })
    }
  }
  return results
}
