// supabase/functions/blockchain-indexer/swapNonceRecovery.ts
//
// UNKNOWN/broadcast-response-loss recovery for Swap. Same architecture as
// payNonceRecovery.ts / bulkpayNonceRecovery.ts (both already production-
// validated) -- a sibling, not a modification to either.
//
// ── Why this matters more for Swap than for Pay ───────────────────────────
// swap-proxy.js's kit.swap() call can throw without ever surfacing a
// txHash (a genuine transport-layer failure before the SDK attaches one --
// see swap-proxy.js's own extractPossibleTxHash/verifySwapLanded comments).
// When that happens, swap-intent's attempt is left CREATED with tx_hash
// NULL and a reserved nonce that may or may not have actually been
// consumed on-chain. This module is what resolves that ambiguity safely --
// it NEVER rebroadcasts, only discovers (or fails to discover) whatever
// really happened to that nonce.
//
// expectedTo is the Kit Adapter Contract address, threaded through exactly
// like payNonceRecovery.ts threads Pay's varying expectedTo -- computed by
// the live wiring layer, never hardcoded here.

export interface UnresolvedSwapAttempt {
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

export type SwapNonceRecoveryOutcome =
  | { outcome: 'confirmed'; txHash: string; blockNumber: number }
  | { outcome: 'replaced'; txHash: string }
  | { outcome: 'not_found' }

/**
 * Scans blocks newest-first for a transaction matching (wallet, nonce).
 * NEVER broadcasts anything -- only discovers or fails to discover an
 * already-mined transaction. A match whose `to` isn't the Kit Adapter
 * Contract is REPLACED, never silently accepted as confirmation -- this is
 * what keeps an unrelated same-nonce transaction (e.g. a manual wallet
 * action) from ever being misread as this swap having landed.
 */
export async function recoverSwapAttemptByNonce(
  fetcher: BlockFetcher,
  attempt: UnresolvedSwapAttempt,
  fromBlockNumber: number,
  toBlockNumber: number,
): Promise<SwapNonceRecoveryOutcome> {
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

export interface SwapAttemptUpdateRepository {
  markSubmitted(attemptId: string, txHash: string): Promise<void>
  markReplaced(attemptId: string, replacementTxHash: string): Promise<void>
  transitionIntentToFailed(intentId: string): Promise<void>
}

export interface SwapNonceRecoveryResult {
  attemptId: string
  outcome: SwapNonceRecoveryOutcome['outcome']
  txHash?: string
}

/**
 * Sweeps unresolved Swap attempts (CREATED/BROADCASTING with tx_hash IS
 * NULL, older than the caller's grace period). Never broadcasts. Byte-for-
 * byte the same orchestration shape as payNonceRecovery.ts's own
 * sweepUnresolvedAttempts.
 *
 * A 'not_found' outcome (genuinely never broadcast -- the nonce was never
 * consumed) is intentionally left CREATED here, not force-failed: the
 * caller (index.ts) is responsible for eventually expiring a CREATED
 * attempt that stays unresolved past a longer bound, exactly as Pay/
 * BulkPay already do. This module's only job is "never rebroadcast, only
 * discover" -- it does not own expiry policy.
 */
export async function sweepUnresolvedSwapAttempts(
  unresolvedAttempts: UnresolvedSwapAttempt[],
  fetcher: BlockFetcher,
  updateRepo: SwapAttemptUpdateRepository,
  scanWindowBlocks: number,
): Promise<SwapNonceRecoveryResult[]> {
  const results: SwapNonceRecoveryResult[] = []
  for (const attempt of unresolvedAttempts) {
    try {
      const currentBlock = await fetcher.getCurrentBlockNumber(attempt.chainId)
      const fromBlock = Math.max(0, currentBlock - scanWindowBlocks)
      const outcome = await recoverSwapAttemptByNonce(fetcher, attempt, fromBlock, currentBlock)

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
      console.error(`[swap-nonce-recovery] attempt ${attempt.id} failed:`, e instanceof Error ? e.message : e)
      results.push({ attemptId: attempt.id, outcome: 'not_found' })
    }
  }
  return results
}
