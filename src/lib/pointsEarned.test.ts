import { describe, it, expect, vi, afterEach } from 'vitest'
import { announcePointsEarned, recentPointsEarned } from './pointsEarned'

afterEach(() => vi.useRealTimers())

describe('points earned by a reward task', () => {
  it('is kept for its own task for a minute, so a success screen drawn after the award still shows it', () => {
    vi.useFakeTimers()
    expect(recentPointsEarned('swap')).toBe(0)
    announcePointsEarned('swap', 20)
    expect(recentPointsEarned('swap')).toBe(20)
    expect(recentPointsEarned('pay_send')).toBe(0)
    vi.advanceTimersByTime(60_001)
    expect(recentPointsEarned('swap')).toBe(0)
  })

  it('ignores an award of nothing (already earned today, business account)', () => {
    announcePointsEarned('chatpay', 0)
    expect(recentPointsEarned('chatpay')).toBe(0)
  })
})
