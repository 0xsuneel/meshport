/**
 * The stuck-release repair policy — deliberately isolated, pure, and free of
 * every dependency (no fetch, no Supabase, no viem, no env).
 *
 * WHY ITS OWN FILE
 * This decision governs other people's money, and it has to be made in two
 * places: the browser sweep in p2pService.ts, and the scheduled server-side
 * reconciler in supabase/functions/p2p-release-reconcile. Two copies of a
 * money-handling rule that can silently drift is a worse failure mode than
 * either copy being wrong, so the logic lives here, in one testable place, and
 * the edge function's mirror is held to it by an explicit parity test
 * (stuckReleasePolicy.parity.test.ts) that runs both across the full input
 * matrix and fails the build on any disagreement.
 *
 * THE STATE BEING REPAIRED
 * Releasing is two steps: claim the trade ('payment_sent' -> 'released'), then
 * move funds on-chain. If the process dies in between — closed tab, lost
 * connection, failed compensating write — the trade is left saying 'released'
 * with released_at NULL and its offer pinned by locked_by_trade_id, forever.
 * A completed release always writes released_at and completed_at together with
 * status='completed', so `status='released' AND released_at IS NULL` is an
 * unambiguous signature for it.
 *
 * THE GOVERNING RULE
 * "Unknown" is never treated as "zero". Every probe that cannot establish an
 * answer must pass null, and every null leads to 'investigate', which changes
 * nothing. Leaving a trade stuck for a human is strictly better than cancelling
 * one whose funds are real, or re-releasing funds that already moved.
 *
 * NO VERDICT MOVES FUNDS. 'restore' only makes a trade eligible for the normal
 * seller-initiated release again, which still requires their wallet to sign.
 */

export type StuckReleaseVerdict =
  | 'finalize'    // the release DID happen on-chain — make the row say so
  | 'restore'     // it did not, and the funds are still there — let the seller retry
  | 'cancel'      // nothing was ever escrowed — the release could never succeed
  | 'investigate' // cannot be established safely — change nothing, report it

export interface StuckReleaseProbe {
  /** contract's own tradeReleased flag; null = could not be determined */
  onChainReleased: boolean | null
  /** escrow still held under this trade's bucket; null = could not be determined */
  escrowRemaining: number | null
  /** did the offer/trade ever record an escrow deposit hash? */
  everDeposited: boolean
  /** the amount this trade owes the buyer */
  amountUsdc: number
}

export interface StuckReleaseDecision {
  verdict: StuckReleaseVerdict
  reason: string
}

export function classifyStuckRelease(p: StuckReleaseProbe): StuckReleaseDecision {
  if (p.onChainReleased === null) {
    return { verdict: 'investigate', reason: 'Could not read the contract tradeReleased flag — refusing to guess.' }
  }
  if (p.onChainReleased) {
    // Funds provably left escrow for this trade. The only correct action is to
    // make the database agree. Reverting here would risk a second release.
    return { verdict: 'finalize', reason: 'Contract reports tradeReleased=true — the buyer was paid; finalizing the record.' }
  }
  // Not released on-chain from here down.
  if (p.escrowRemaining === null) {
    return { verdict: 'investigate', reason: 'Release did not happen, but the escrow balance could not be read — refusing to guess.' }
  }
  if (p.escrowRemaining >= p.amountUsdc) {
    return { verdict: 'restore', reason: `Release did not happen and ${p.escrowRemaining} USDC is still escrowed — returning the trade to payment_sent so it can be retried.` }
  }
  if (p.escrowRemaining > 0) {
    return { verdict: 'investigate', reason: `Escrow holds ${p.escrowRemaining} USDC but the trade owes ${p.amountUsdc} — partial funds, needs a human.` }
  }
  // escrowRemaining === 0
  if (p.everDeposited) {
    return { verdict: 'investigate', reason: 'Escrow was funded at some point but now holds nothing and this trade was never released — unexplained; needs a human.' }
  }
  return { verdict: 'cancel', reason: 'No escrow was ever deposited, so the release could never have succeeded — cancelling and unlocking the offer.' }
}

/** A trade is only considered stuck once this long has passed since the claim. */
export const STUCK_RELEASE_GRACE_MS = 5 * 60 * 1000

// ── Activation boundary ──────────────────────────────────────────────────────
//
// Turning a repair job on must not retroactively rewrite history. At the time
// this was written two trades had already been stuck for weeks — one holding
// 5 USDC of real escrow — and both were under human review. A reconciler that
// swept "everything currently stuck" on its first run would have restored one
// and cancelled the other before anyone approved it.
//
// So eligibility is gated on an explicit activation timestamp, and the gate
// FAILS CLOSED: with no cutoff configured the reconciler processes NOTHING and
// says so. Enabling the schedule before deciding the cutoff is therefore inert
// rather than destructive — the failure mode of a misconfiguration is "did
// nothing", never "changed historical rows".
//
// The cutoff is configuration, not a constant, precisely so that no arbitrary
// date is baked into the source: the operator sets it to the moment they
// actually activate, and it is echoed back in every response and log line.

/**
 * Parses an activation cutoff. Returns null — meaning DORMANT — for anything
 * missing, blank or unparseable, so a typo can never widen the scope.
 */
export function parseActivationCutoff(raw: string | undefined | null): number | null {
  if (!raw) return null
  const trimmed = String(raw).trim()
  if (!trimmed) return null
  const ms = Date.parse(trimmed)
  return Number.isFinite(ms) ? ms : null
}

export interface ReconcileEligibilityInput {
  tradeId: string
  createdAtIso: string
  /** null = dormant */
  cutoffMs: number | null
  graceMs: number
  nowMs: number
  /** explicit denylist, checked independently of the timestamp */
  skipTradeIds?: string[]
}

/**
 * Is this stuck trade in scope for automatic repair?
 *
 * Two independent guards must both pass, so neither alone is a single point of
 * failure: the activation timestamp, and an explicit skip list for individually
 * quarantined trades.
 *
 * The boundary is STRICTLY after the cutoff. A trade created at exactly the
 * cutoff instant is treated as historical and left alone — when in doubt about
 * whether something predates activation, the safe answer is "don't touch it".
 */
export function isEligibleForReconcile(i: ReconcileEligibilityInput): { eligible: boolean; reason: string } {
  if (i.cutoffMs === null) {
    return { eligible: false, reason: 'Reconciler dormant — no activation cutoff configured.' }
  }
  if (i.skipTradeIds?.includes(i.tradeId)) {
    return { eligible: false, reason: 'Trade is on the explicit skip list — quarantined for manual review.' }
  }
  const createdMs = Date.parse(i.createdAtIso)
  if (!Number.isFinite(createdMs)) {
    return { eligible: false, reason: 'Trade created_at is unparseable — refusing to act on it.' }
  }
  if (createdMs <= i.cutoffMs) {
    return { eligible: false, reason: 'Trade predates the activation cutoff — historical, left for manual review.' }
  }
  if (createdMs > i.nowMs - i.graceMs) {
    return { eligible: false, reason: 'Trade is still inside the grace window — a release may yet be in flight.' }
  }
  return { eligible: true, reason: 'Created after activation and past the grace window.' }
}
