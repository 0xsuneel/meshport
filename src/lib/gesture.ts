// src/lib/gesture.ts
//
// Where a released swipe would come to rest if it coasted - the same
// exponential deceleration as native scrolling (Apple's "Designing Fluid
// Interfaces" projection). Swipes pick their target from this landing point
// rather than from where the finger let go, so a short quick flick still
// switches and a slow long drag doesn't overshoot.

/** Extra distance (px) a release at `velocity` px/s travels before stopping. */
export function projectMomentum(velocity: number, decelerationRate = 0.998): number {
  return (velocity / 1000) * decelerationRate / (1 - decelerationRate)
}
