// supabase/functions/blockchain-indexer/attemptReaper.ts
//
// Bounded expiry/reaper for transaction_attempts that never resolved a
// tx_hash at all. Covers Pay, BulkPay, and Swap uniformly, because all
// three share the same canonical transaction_attempts table and status
// vocabulary (see supabase/migrations/20260823060000_phase1_canonical_
// transaction_model.sql) -- this is one shared module, not three per-
// feature copies, deliberately, to avoid the risk of the three drifting.
//
// ── Why this exists ────────────────────────────────────────────────────
// server/transactionStateMachine/transitions.ts already defines the right
// terminal state for exactly this case -- CREATED: ['BROADCASTING',
// 'DROPPED'] -- but that module is never imported by any live Edge
// Function (comment-references only), so nothing has ever actually written
// DROPPED in production. A CREATED attempt whose tx_hash never resolves
// (nonce-recovery exhausted it for Pay/BulkPay, and now nonce-recovery AND
// swap-broadcast-recovery have both exhausted it for Swap) was left in
// CREATED forever, with its parent intent stuck at SUBMITTED forever too --
// visible to nobody, resolved by nothing.
//
// ── Scope, deliberately narrow ─────────────────────────────────────────
// This reaper ONLY ever touches attempts with status='CREATED' AND
// tx_hash IS NULL -- i.e. attempts that never even got a real transaction
// hash. It NEVER touches an attempt that has a real tx_hash but simply
// hasn't confirmed yet (status SUBMITTED/CONFIRMING/UNKNOWN with a real
// hash) -- docs/TRANSACTION_STATE_MACHINE.md is explicit that a broadcast
// transaction must never be marked FAILED merely because confirmation
// timed out, and this reaper does not override that rule. It also never
// touches CONFIRMED/REVERTED/REPLACED/DROPPED attempts (already terminal).
//
// ── Bound ───────────────────────────────────────────────────────────────
// The caller supplies boundHours (see index.ts's 'attempt-reaper' mode,
// default 24h). 24h is comfortably past every existing recovery window:
// pay/bulkpay nonce-recovery's own ~17-minute block-scan window (refreshed
// every 5 minutes), and swap-broadcast-recovery's 60-minute correlation
// window (itself gated behind a 30-minute grace period) -- so by the time
// this reaper would act on a row, every automated recovery path has
// already had many chances to resolve it first.
//
// ── Terminal transition used ───────────────────────────────────────────
// attempt.status CREATED -> DROPPED (the state machine's own intended
// target for this exact case) and the parent intent SUBMITTED -> FAILED --
// the identical pair swapNonceRecovery.ts's own REPLACED path already uses
// today (markReplaced + transitionIntentToFailed), so this reaper
// introduces no new status value and no new intent-level transition beyond
// one the codebase already trusts in production.

/**
 * Pure cutoff math, extracted so the boundary itself is directly testable
 * without a database. The live finder (attemptReaperLive.ts) uses this same
 * function to build its `created_at < cutoff` filter -- fresh attempts
 * (created after the cutoff) are excluded by construction, not by any
 * runtime check in the sweep loop itself.
 */
export function computeStaleCutoffIso(boundHours: number, nowMs: number = Date.now()): string {
  return new Date(nowMs - boundHours * 3_600_000).toISOString()
}

export interface StaleCreatedAttempt {
  id: string
  intentId: string
  feature: string
  chainId: string
  createdAt: string
}

export interface AttemptReaperUpdateRepository {
  /**
   * Must be implemented as two independently WHERE-guarded updates
   * (attempt: status=eq.CREATED AND tx_hash=is.null; intent:
   * status=eq.SUBMITTED) -- see attemptReaperLive.ts. That guard is what
   * makes a concurrent cron overlap, or a last-second real recovery that
   * lands between this sweep's SELECT and UPDATE, a safe no-op rather than
   * a race: whichever writer gets there first wins, and this reaper's own
   * write simply matches zero rows if it loses that race.
   */
  dropAttemptAndFailIntent(attemptId: string, intentId: string): Promise<void>
}

export interface StaleAttemptFinder {
  findStaleCreatedAttempts(boundHours: number): Promise<StaleCreatedAttempt[]>
}

export interface AttemptReaperResult {
  attemptId: string
  intentId: string
  feature: string
  outcome: 'dropped'
}

/**
 * Sweeps whatever the finder returns and expires each one. All of the
 * actual safety logic (which statuses qualify, the age bound, never
 * touching a real tx_hash) lives in the finder's query -- this function is
 * intentionally a thin, uniform loop, so it can't accidentally diverge in
 * behavior between Pay/BulkPay/Swap. One attempt's failure never aborts
 * the rest of the batch.
 */
export async function sweepStaleCreatedAttempts(
  staleAttempts: StaleCreatedAttempt[],
  updateRepo: AttemptReaperUpdateRepository,
): Promise<AttemptReaperResult[]> {
  const results: AttemptReaperResult[] = []
  for (const a of staleAttempts) {
    try {
      await updateRepo.dropAttemptAndFailIntent(a.id, a.intentId)
      results.push({ attemptId: a.id, intentId: a.intentId, feature: a.feature, outcome: 'dropped' })
    } catch (e) {
      console.error(`[attempt-reaper] attempt ${a.id} (${a.feature}) failed:`, e instanceof Error ? e.message : e)
    }
  }
  return results
}
