// supabase/functions/blockchain-indexer/bulkpayNonceRecovery.ts
//
// Recovers a BulkPay transaction_attempt's tx_hash when the frontend never
// received the broadcast response at all (Case 2 in docs/
// BULKPAY_BROADCAST_RESPONSE_LOSS_AUDIT.md -- distinct from Case 1, receipt
// timeout, which already has a real tx_hash to persist).
//
// ── The mechanism, and why it's the only one available ─────────────────────
// A wallet's EVM account transaction nonce is not emitted as a log topic
// anywhere (confirmed in the audit -- unlike CCTP's own protocol-level
// nonce, which IS an indexed event topic and IS searchable via
// eth_getLogs, per claim-recovery-scan's existing findSourceBurnTx). The
// only way to turn (wallet, nonce) into a real tx_hash is to read the raw
// transaction list of recent blocks directly -- the exact
// eth_getBlockByNumber(..., true) RPC call scanner.ts's own native
// top-level scan already makes, for an unrelated purpose, reused here for
// its RPC shape only, not its code.
//
// ── The security-critical rule ──────────────────────────────────────────────
// A nonce match ALONE is not sufficient: a wallet can replace a
// transaction with a different one using the same nonce. A found candidate
// is only ever accepted once its `to` field is independently verified as
// Multicall3. If a real transaction is found at this (wallet, nonce) but
// its `to` does NOT match, this is a genuine replacement -- the original
// attempt correctly resolves to REPLACED, never CONFIRMED, and the
// original BulkPay payment simply never happened. This module NEVER
// broadcasts anything -- it only ever discovers or fails to discover a
// real, already-mined transaction.

const MULTICALL3_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11'

export interface UnresolvedAttempt {
  id: string
  intentId: string
  chainId: string
  walletAddress: string
  nonce: number
  createdAt: string
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
 * Scans a bounded range of recent blocks for a transaction from
 * attempt.walletAddress with nonce === attempt.nonce. Never broadcasts
 * anything. fromBlockNumber/toBlockNumber are supplied by the caller
 * (typically: current head, and current head minus a bounded window sized
 * against the attempt's own age) -- this function does not decide the
 * window's size itself, keeping that policy decision at the call site
 * where it can be tuned against real, measured Arc timing (not resolved
 * here).
 */
export async function recoverAttemptByNonce(
  fetcher: BlockFetcher,
  attempt: UnresolvedAttempt,
  fromBlockNumber: number,
  toBlockNumber: number,
): Promise<NonceRecoveryOutcome> {
  const wallet = attempt.walletAddress.trim().toLowerCase()

  for (let bn = toBlockNumber; bn >= fromBlockNumber; bn--) {
    const block = await fetcher.getBlockWithTransactions(attempt.chainId, bn)
    if (!block) continue

    for (const tx of block.transactions) {
      if ((tx.from ?? '').toLowerCase() !== wallet) continue
      let txNonce: number
      try { txNonce = Number(BigInt(tx.nonce)) } catch { continue }
      if (txNonce !== attempt.nonce) continue

      const to = (tx.to ?? '').toLowerCase()
      if (to === MULTICALL3_ADDRESS) {
        return { outcome: 'confirmed', txHash: tx.hash.toLowerCase(), blockNumber: bn }
      }
      return { outcome: 'replaced', txHash: tx.hash.toLowerCase() }
    }
  }

  return { outcome: 'not_found' }
}

// ── Orchestration ────────────────────────────────────────────────────────

/** The DB write boundary for applying a recovery outcome — separate from BlockFetcher (read-only RPC). */
export interface AttemptUpdateRepository {
  /** Sets tx_hash + status='SUBMITTED' on the attempt — from this point on, the SAME confirmation/reconciliation machinery already built for Case 1 takes over (unchanged by this module). */
  markSubmitted(attemptId: string, txHash: string): Promise<void>
  /** Sets status='REPLACED' — the original BulkPay payment never happened; a new, explicit intent is required to retry, never automatic. */
  markReplaced(attemptId: string, replacementTxHash: string): Promise<void>
  /** Transitions the parent transaction_intent SUBMITTED -> FAILED once its attempt is confirmed REPLACED — the original operation genuinely never happened, so its intent must reflect that terminal outcome too, not stay stuck at SUBMITTED. */
  transitionIntentToFailed(intentId: string): Promise<void>
}

export interface NonceRecoveryResult {
  attemptId: string
  outcome: NonceRecoveryOutcome['outcome']
  txHash?: string
}

/**
 * Sweeps unresolved attempts (found via findUnresolvedAttempts, Case 2's
 * signal) and attempts nonce-based recovery for each. Never broadcasts
 * anything. An attempt with `not_found` is left untouched — the caller's
 * own longer bound (docs/BULKPAY_BROADCAST_RESPONSE_LOSS_AUDIT.md §9's
 * "longer, final bound") decides when to give up and converge to DROPPED,
 * a decision deliberately NOT made inside this sweep itself (kept simple,
 * matching runBulkpayReconciliation's own "give up cleanly, don't retry
 * forever" reasoning, but the final-DROPPED transition is left to a
 * separate, explicit step — not resolved in this pass, see the
 * implementation report's "remaining known gaps").
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
      // One attempt's failure must not abort the sweep — same resilience
      // discipline as runBulkpayReconciliation's per-row try/catch.
      console.error(`[bulkpay-nonce-recovery] attempt ${attempt.id} failed:`, e instanceof Error ? e.message : e)
      results.push({ attemptId: attempt.id, outcome: 'not_found' })
    }
  }
  return results
}
