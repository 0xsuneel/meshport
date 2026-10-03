/**
 * ClaimProgressTracker.tsx
 *
 * Server-truth progress checklist for a single claim, shown on the "Track
 * Progress" screen (Submitted is confirmed on the screen before this one):
 *   ✓ Bridging → ✓ Verifying → ✓ Settling → ✓ Completed
 *
 * Driven by the claims row (subscribeToClaim) plus Circle directly (Iris):
 * Circle's forwarder mints on Arc within seconds, but the row only flips to
 * 'completed' on the server worker's next pass — so Completed shows as soon
 * as Circle reports the Arc mint. Rendered by UbProgressTracker, the same
 * component every Track Progress screen uses.
 */
import { useEffect, useState } from 'react'
import { subscribeToClaim, TRACK_PROGRESS_STEPS, type Claim } from '@/lib/claimService'
import { useCctpProgress } from '@/lib/cctpTracker'
import { UbProgressTracker, type UbTrackerProgress } from './UbProgressTracker'

// Claim status → tracker stage (Bridging=0, Verifying=1, Settling=2, Completed=3).
const STAGE: Record<string, UbTrackerProgress['stage']> = {
  submitted: 'burning', bridging: 'burning', verifying: 'attesting', settling: 'minting', completed: 'done', failed: 'error',
}

export function ClaimProgressTracker({ claimId, initialClaim }: { claimId: string; initialClaim?: Claim | null }) {
  // Starting from the claim the caller already fetched avoids a first
  // render that guesses the step and then jumps.
  const [claim, setClaim] = useState<Claim | null>(initialClaim ?? null)

  useEffect(() => {
    const unsubscribe = subscribeToClaim(claimId, setClaim)
    return unsubscribe
  }, [claimId])

  const rowStatus = claim?.status
  const rowFinal = rowStatus === 'completed' || rowStatus === 'failed'
  const iris = useCctpProgress(claim && !rowFinal ? claim.sourceChain : undefined, claim && !rowFinal ? claim.txHash : undefined)
  const status = !rowFinal && iris?.stage === 'done' ? 'completed' : rowStatus

  const progress: UbTrackerProgress = {
    stage: STAGE[status ?? 'submitted'] ?? 'burning',
    msg: status === 'failed' ? (claim?.error ?? 'Claim failed. Please try again or contact support.') : undefined,
  }

  return (
    <UbProgressTracker
      loading={!claim}
      progress={progress}
      chainLabel=""
      steps={TRACK_PROGRESS_STEPS.map(s => ({ label: s.label, subtitle: s.subtitle }))}
      // claim-worker flags needs_review once a claim has been stuck >10 min.
      note={claim?.needsReview ? 'This is taking longer than usual — our team has been notified. No action needed; it keeps retrying automatically.' : undefined}
    />
  )
}
