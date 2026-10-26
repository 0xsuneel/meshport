// src/lib/balanceTrend.ts
//
// The Home balance bars: the account's balance at the end of each of the
// last `days` days, worked out backwards from today's balance and the
// Activity in between (MeshPort keeps no balance snapshots):
//
//   end of day d = today's balance − everything that came in after day d
//                                  + everything that went out after day d
//
// Values are in USD (each record's usdValue, falling back to its amount);
// failed records never moved money and are skipped. Swaps and other '↔'
// rows don't change the total. Pure - unit tested.

import { activitySign, type ActivityRecord } from './ActivityService'

export interface BalanceTrend {
  /** End-of-day balances, oldest first; the last one is today (= the current balance). */
  values: number[]
  /** One label per value: weekday names, the last one 'Today'. */
  labels: string[]
  /** Change over the whole span (last − first). */
  change: number
}

type TrendRecord = Pick<ActivityRecord, 'activityType' | 'amount' | 'usdValue' | 'status' | 'createdAt' | 'metadata'>

const DAY_MS = 86_400_000

export function balanceTrend(records: TrendRecord[], currentBalance: number, now = new Date(), days = 7): BalanceTrend {
  // Midnight starting each of the last `days` days, oldest first.
  const today = new Date(now); today.setHours(0, 0, 0, 0)
  const dayStarts = Array.from({ length: days }, (_, i) => today.getTime() - (days - 1 - i) * DAY_MS)
  const moves = records
    .filter(r => r.status !== 'failed')
    .map(r => {
      const sign = activitySign(r.activityType, r.metadata?.direction)
      const usd = Number.isFinite(r.usdValue) && r.usdValue > 0 ? r.usdValue : r.amount
      return { at: new Date(r.createdAt).getTime(), delta: sign === '+' ? usd : sign === '-' ? -usd : 0 }
    })
    .filter(m => m.delta !== 0 && Number.isFinite(m.at))
  const values = dayStarts.map((start, i) => {
    if (i === days - 1) return currentBalance
    const endOfDay = start + DAY_MS
    const after = moves.reduce((s, m) => (m.at >= endOfDay ? s + m.delta : s), 0)
    return Math.max(0, currentBalance - after)
  })
  const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
  const labels = dayStarts.map((start, i) => (i === days - 1 ? 'Today' : fmtDay.format(new Date(start))))
  return { values, labels, change: values[values.length - 1] - values[0] }
}
