// lib/pointsEarned.ts
//
// Points just earned by one of the daily reward tasks, for the action's own
// success screen ("+20 points · Send a payment ✓") and a Rewards page that
// is open. The award resolves a moment after the payment / swap succeeds -
// before or after its success screen is drawn - so the last award per task
// is kept for a minute and announced with an event.
import type { RewardActionType } from './rewards'

export const POINTS_EARNED_EVENT = 'meshport:points-earned'
const KEEP_MS = 60_000
const last = new Map<RewardActionType, { points: number; at: number }>()

export function announcePointsEarned(type: RewardActionType, points: number) {
  if (!(points > 0)) return
  last.set(type, { points, at: Date.now() })
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(POINTS_EARNED_EVENT, { detail: { type, points } }))
}

/** Points this task earned in the last minute (0 if none). */
export function recentPointsEarned(type: RewardActionType): number {
  const p = last.get(type)
  return p && Date.now() - p.at < KEEP_MS ? p.points : 0
}
