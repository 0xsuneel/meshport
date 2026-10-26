import { describe, it, expect } from 'vitest'
import { balanceTrend } from './balanceTrend'

const NOW = new Date('2026-10-26T15:00:00')
const rec = (daysAgo: number, type: string, usd: number, extra: Record<string, unknown> = {}) => ({
  activityType: type as any, amount: usd, usdValue: usd, status: 'completed' as any, metadata: {},
  createdAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(), ...extra,
})

describe('Home balance bars', () => {
  it('works each day out backwards from today; today is the current balance', () => {
    // received $10 two days ago, sent $4 yesterday; balance now $25.86
    const t = balanceTrend([rec(2, 'receive', 10), rec(1, 'send', 4)], 25.86, NOW)
    expect(t.values).toHaveLength(7)
    expect(t.values[6]).toBe(25.86)
    expect(t.values[5]).toBeCloseTo(25.86)           // end of yesterday: the send had already left
    expect(t.values[4]).toBeCloseTo(25.86 + 4)       // end of 2 days ago: after the receive, before the send
    expect(t.values[3]).toBeCloseTo(25.86 + 4 - 10)  // end of 3 days ago: before both
    expect(t.labels[6]).toBe('Today')
    expect(t.change).toBeCloseTo(25.86 - (25.86 + 4 - 10))
  })

  it('end of yesterday includes yesterday\'s send', () => {
    const t = balanceTrend([rec(1, 'send', 4)], 20, NOW)
    expect(t.values[5]).toBe(20)  // the send happened yesterday, so by the end of yesterday it had left
    expect(t.values[4]).toBe(24)  // the day before, it was still there
  })

  it('skips failed records and swaps; never goes below zero', () => {
    const t = balanceTrend([rec(1, 'send', 50, { status: 'failed' }), rec(1, 'swap', 30), rec(3, 'receive', 100)], 10, NOW)
    expect(t.values[5]).toBe(10)
    expect(t.values[2]).toBe(0)   // 10 − 100 would be negative
  })

  it('uses USD value when present (EURC and others)', () => {
    const t = balanceTrend([rec(1, 'receive', 0, { amount: 4.41, usdValue: 4.76 })], 25.86, NOW)
    expect(t.values[4]).toBeCloseTo(25.86 - 4.76)
  })

  it('no activity: a flat week at the current balance', () => {
    const t = balanceTrend([], 12.5, NOW)
    expect(new Set(t.values)).toEqual(new Set([12.5]))
    expect(t.change).toBe(0)
  })
})
