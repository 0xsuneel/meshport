import { describe, it, expect, vi } from 'vitest'
vi.mock('./supabase', () => ({ supabase: {} }))
import { rateAt, type FxPoint } from './fxHistory'

const h: FxPoint[] = [
  { usdRate: 83.1, at: '2026-10-16T00:05:00Z' },
  { usdRate: 83.4, at: '2026-10-17T00:05:00Z' },
  { usdRate: 83.2, at: '2026-10-18T00:05:00Z' },
]

describe('rateAt', () => {
  it('takes the latest rate at or before the time', () => {
    expect(rateAt(h, '2026-10-17T15:00:00Z')).toEqual({ ...h[1], before: false })
    expect(rateAt(h, '2026-10-17T00:05:00Z')).toEqual({ ...h[1], before: false })
    expect(rateAt(h, '2026-10-19T09:00:00Z')).toEqual({ ...h[2], before: false })
  })
  it('flags a time before the history with the earliest rate', () => {
    expect(rateAt(h, '2026-10-01T00:00:00Z')).toEqual({ ...h[0], before: true })
  })
  it('is null without any rates', () => {
    expect(rateAt([], '2026-10-17T00:00:00Z')).toBeNull()
  })
})
