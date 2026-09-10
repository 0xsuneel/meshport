/**
 * Server-side mirror of src/lib/stuckReleasePolicy.ts.
 *
 * WHY A MIRROR AND NOT AN IMPORT
 * Edge functions deploy from supabase/functions/ and cannot reach into src/, so
 * the browser and the scheduler physically cannot share one file. Two copies of
 * a money-handling rule that can silently drift would be worse than either copy
 * being wrong, so this file is held to the canonical one by
 * src/lib/stuckReleasePolicy.parity.test.ts, which imports BOTH and asserts they
 * return identical verdicts across the exhaustive input matrix. If they ever
 * disagree, the build fails.
 *
 * Keep this file free of Deno APIs so vitest can import it directly.
 *
 * The governing rule: "unknown" is never treated as "zero", and no verdict moves
 * funds. See the canonical file for the full reasoning.
 */

export type StuckReleaseVerdict = 'finalize' | 'restore' | 'cancel' | 'investigate'

export interface StuckReleaseProbe {
  onChainReleased: boolean | null
  escrowRemaining: number | null
  everDeposited: boolean
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
    return { verdict: 'finalize', reason: 'Contract reports tradeReleased=true — the buyer was paid; finalizing the record.' }
  }
  if (p.escrowRemaining === null) {
    return { verdict: 'investigate', reason: 'Release did not happen, but the escrow balance could not be read — refusing to guess.' }
  }
  if (p.escrowRemaining >= p.amountUsdc) {
    return { verdict: 'restore', reason: `Release did not happen and ${p.escrowRemaining} USDC is still escrowed — returning the trade to payment_sent so it can be retried.` }
  }
  if (p.escrowRemaining > 0) {
    return { verdict: 'investigate', reason: `Escrow holds ${p.escrowRemaining} USDC but the trade owes ${p.amountUsdc} — partial funds, needs a human.` }
  }
  if (p.everDeposited) {
    return { verdict: 'investigate', reason: 'Escrow was funded at some point but now holds nothing and this trade was never released — unexplained; needs a human.' }
  }
  return { verdict: 'cancel', reason: 'No escrow was ever deposited, so the release could never have succeeded — cancelling and unlocking the offer.' }
}

export const STUCK_RELEASE_GRACE_MS = 5 * 60 * 1000

// ── Activation boundary — mirror of the canonical file, parity-enforced ──────
// Fails closed: no cutoff configured means process NOTHING. See the canonical
// file for the full reasoning (two real trades were under human review when this
// was written and must not be swept on first run).

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
  cutoffMs: number | null
  graceMs: number
  nowMs: number
  skipTradeIds?: string[]
}

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
