// supabase/functions/blockchain-indexer/swapBroadcastRecovery.ts
//
// Swap broadcast-loss recovery -- the durable fix for the class of bug
// that produced the real orphaned attempt b3eb0389.../intent ff52946c...
// (7 EURC -> USDC, real tx 0xbffd9ed6..., landed on-chain but never
// recorded against its attempt).
//
// ── Why this exists, and why swapNonceRecovery.ts alone cannot cover it ──
// swapNonceRecovery.ts's block-scan matches on `tx.nonce === attempt.nonce`.
// That is correct and sufficient for Pay/BulkPay, which construct their own
// raw transaction and pass the reserved nonce to the signer explicitly. It
// is structurally incapable of helping Swap: swap-proxy.js never references
// `nonce` at all (Circle's Kit SDK allocates the real broadcast nonce
// internally, and may even broadcast more than one transaction per
// kit.swap() call -- an approve, then the swap itself). The nonce stored on
// a swap's transaction_attempt is disclosed as informational-only in
// swapIntentService.ts's own header. A CREATED/tx_hash-NULL swap attempt
// therefore needs a correlation signal that does not depend on nonce.
//
// ── The correlation signal used here ──────────────────────────────────────
// The wallet's own real swap output (Kit Adapter Contract -> wallet) is
// already independently captured by the ordinary scanner as a chain_event,
// completely regardless of whether the attempt ever learned its tx_hash --
// this is exactly what happened in the real orphan case (chain_event id 199
// existed within 2.5 minutes of broadcast). So: find unclaimed chain_events
// whose sender is the Kit Adapter Contract, for this exact wallet, within a
// bounded window after the attempt was created. Never guess: proceed only
// when exactly one such candidate exists, and only after independently
// re-verifying the real transaction (tx.from/tx.to) via RPC -- the same
// authoritative check swapConfirmation.ts already trusts for ordinary
// confirmation. The chain_event match is only how a candidate is *found*;
// the RPC check is the actual proof it belongs to this wallet.
//
// ── What this module does NOT do ──────────────────────────────────────────
// It never rebroadcasts anything (no signing, no RPC write calls -- reads
// only). It never marks CONFIRMED, never writes chain_events or
// ledger_events, and never duplicates swapConfirmation.ts's or
// swapReconcile.ts's own logic -- it does exactly one thing: safely
// discover and persist the real tx_hash to an otherwise-unresolvable
// attempt, via the SAME markSubmitted repository call swapNonceRecovery.ts
// already uses. Once that lands, the existing swap-confirm-sweep and
// swap-reconcile-sweep take over completely unmodified.

export interface UnresolvedSwapAttemptForBroadcastRecovery {
  id: string
  intentId: string
  chainId: string
  walletAddress: string
  createdAt: string
}

/**
 * A candidate real-output chain_event for this wallet. The caller
 * (BroadcastRecoveryCandidateFinder's live implementation) is responsible
 * for pre-filtering to: sender = Kit Adapter Contract, wallet_address =
 * this attempt's wallet, status='confirmed', created_at within the search
 * window, AND tx_hash not already present on any OTHER transaction_attempts
 * row for feature='swap' (the "never accidentally claim another
 * transaction's evidence" guarantee lives in that query, enforced at the DB
 * level via a NOT EXISTS / anti-join -- this module only ever sees
 * candidates that are already unclaimed).
 */
export interface CandidateChainEvent {
  txHash: string
  createdAt: string
}

export type CandidateSelection =
  | { outcome: 'none' }
  | { outcome: 'ambiguous'; count: number }
  | { outcome: 'one'; txHash: string }

/**
 * Pure decision: never picks a candidate unless it is the ONLY one. Two or
 * more candidates for the same wallet/window is a genuine ambiguity (e.g.
 * two swaps broadcast close together with both submit-callbacks lost) that
 * this module refuses to resolve by guessing -- it is surfaced as
 * 'ambiguous' for operator attention, never silently picked.
 */
export function selectBroadcastRecoveryCandidate(candidates: CandidateChainEvent[]): CandidateSelection {
  if (candidates.length === 0) return { outcome: 'none' }
  if (candidates.length > 1) return { outcome: 'ambiguous', count: candidates.length }
  return { outcome: 'one', txHash: candidates[0].txHash }
}

export interface RawTransactionForBroadcastVerify {
  hash: string
  from: string
  to: string | null
}

export interface BroadcastVerifier {
  getTransaction(chainId: string, txHash: string): Promise<RawTransactionForBroadcastVerify | null>
}

export type BroadcastVerificationOutcome =
  | { outcome: 'verified' }
  | { outcome: 'mismatch'; reason: string }
  | { outcome: 'missing' }

/**
 * The actual proof, independent of how the candidate was found: the real
 * transaction's sender MUST be this exact wallet (its own signature, not
 * spoofable/coincidental) and its recipient MUST be the Kit Adapter
 * Contract -- the same two checks swapConfirmation.ts's
 * verifySwapAttemptConfirmation already performs for ordinary confirmation.
 * A mismatch here means the chain_event candidate was NOT actually this
 * wallet's own broadcast (e.g. a same-symbol transfer routed some other
 * way) and is never trusted, however plausible the chain_event looked.
 */
export async function verifyBroadcastRecoveryCandidate(
  verifier: BroadcastVerifier,
  attempt: UnresolvedSwapAttemptForBroadcastRecovery,
  txHash: string,
  kitAdapterContract: string,
): Promise<BroadcastVerificationOutcome> {
  const tx = await verifier.getTransaction(attempt.chainId, txHash)
  if (!tx) return { outcome: 'missing' }
  const from = (tx.from ?? '').toLowerCase()
  if (from !== attempt.walletAddress.toLowerCase()) {
    return { outcome: 'mismatch', reason: `tx.from ${from} does not match attempt wallet ${attempt.walletAddress}` }
  }
  const to = (tx.to ?? '').toLowerCase()
  if (to !== kitAdapterContract.toLowerCase()) {
    return { outcome: 'mismatch', reason: `tx.to ${to} does not match expected Kit Adapter Contract ${kitAdapterContract}` }
  }
  return { outcome: 'verified' }
}

export interface BroadcastRecoveryCandidateFinder {
  findCandidates(
    attempt: UnresolvedSwapAttemptForBroadcastRecovery,
    windowMinutes: number,
    kitAdapterContract: string,
  ): Promise<CandidateChainEvent[]>
}

export interface BroadcastRecoveryUpdateRepository {
  /**
   * Identical contract to swapNonceRecovery.ts's own markSubmitted:
   * transitions tx_hash + status='SUBMITTED' + submitted_at, guarded in the
   * live implementation by `status=eq.CREATED&tx_hash=is.null` so a
   * concurrent recovery (this sweep running twice, a race with the client's
   * own markSwapAttemptSubmitted call, or api/swap-proxy.js's own new
   * server-side persistence) can never double-write -- whichever lands
   * first wins, the rest are no-ops.
   */
  markSubmitted(attemptId: string, txHash: string): Promise<void>
}

export interface BroadcastRecoveryResult {
  attemptId: string
  outcome: 'resolved' | 'no_candidate' | 'ambiguous' | 'verification_failed' | 'missing'
  txHash?: string
  reason?: string
}

/**
 * Sweeps swap attempts that are CREATED with tx_hash still NULL, past
 * nonce-recovery's own grace window (the caller is responsible for that
 * age filter -- see findUnresolvedSwapAttemptsForBroadcastRecovery in the
 * live wiring), and attempts to durably resolve each one's real tx_hash.
 * Idempotent by construction: once an attempt resolves, it is no longer
 * CREATED/tx_hash-NULL, so it naturally drops out of the next sweep's
 * worklist -- there is no separate "already processed" flag to maintain.
 * One attempt's failure never aborts the rest of the batch.
 */
export async function sweepUnresolvedSwapAttemptsForBroadcastRecovery(
  unresolvedAttempts: UnresolvedSwapAttemptForBroadcastRecovery[],
  finder: BroadcastRecoveryCandidateFinder,
  verifier: BroadcastVerifier,
  updateRepo: BroadcastRecoveryUpdateRepository,
  windowMinutes: number,
  kitAdapterContract: string,
): Promise<BroadcastRecoveryResult[]> {
  const results: BroadcastRecoveryResult[] = []
  for (const attempt of unresolvedAttempts) {
    try {
      const candidates = await finder.findCandidates(attempt, windowMinutes, kitAdapterContract)
      const selection = selectBroadcastRecoveryCandidate(candidates)

      if (selection.outcome === 'none') {
        results.push({ attemptId: attempt.id, outcome: 'no_candidate' })
        continue
      }
      if (selection.outcome === 'ambiguous') {
        results.push({ attemptId: attempt.id, outcome: 'ambiguous', reason: `${selection.count} candidates in window` })
        continue
      }

      const verification = await verifyBroadcastRecoveryCandidate(verifier, attempt, selection.txHash, kitAdapterContract)
      if (verification.outcome === 'verified') {
        await updateRepo.markSubmitted(attempt.id, selection.txHash)
        results.push({ attemptId: attempt.id, outcome: 'resolved', txHash: selection.txHash })
      } else if (verification.outcome === 'missing') {
        results.push({ attemptId: attempt.id, outcome: 'missing' })
      } else {
        results.push({ attemptId: attempt.id, outcome: 'verification_failed', reason: verification.reason })
      }
    } catch (e) {
      console.error(`[swap-broadcast-recovery] attempt ${attempt.id} failed:`, e instanceof Error ? e.message : e)
      results.push({ attemptId: attempt.id, outcome: 'no_candidate' })
    }
  }
  return results
}
