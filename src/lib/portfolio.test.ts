import { describe, it, expect } from 'vitest'
import { portfolioUsd, portfolioTrend } from './portfolio'

const NOW = new Date('2026-10-26T15:00:00')
const swap = (daysAgo: number, tokenIn: string, amountIn: number, tokenOut: string, amountOut: number) => ({
  activityType: 'swap' as any, amount: amountIn, usdValue: amountIn, status: 'completed' as any, tokenSymbol: tokenIn,
  metadata: { tokenIn, amountIn: String(amountIn), tokenOut, amountOut: String(amountOut) },
  createdAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
})
const P = { EURC: 1.16, cirBTC: 100_000 }

describe('Home portfolio total (all assets at market price)', () => {
  it('adds every asset at its price', () => {
    expect(portfolioUsd({ USDC: 20, EURC: 5, cirBTC: 0.0001 }, P)).toBeCloseTo(20 + 5.8 + 10)
  })

  it('an unknown price counts that asset as 0, never a made-up rate', () => {
    expect(portfolioUsd({ USDC: 20, EURC: 5, cirBTC: 1 }, { EURC: 0, cirBTC: 0 })).toBe(20)
  })

  it('a swap moves value between assets: the total follows what you actually hold', () => {
    // Swapped 1 USDC for 1.377 EURC yesterday (the testnet pool's rate).
    const h = { USDC: 19, EURC: 1.377, cirBTC: 0 }
    const t = portfolioTrend([swap(1, 'USDC', 1, 'EURC', 1.377)], h, P, NOW)
    expect(t.values[4]).toBeCloseTo(20)                  // before: 20 USDC
    expect(t.values[6]).toBeCloseTo(19 + 1.377 * 1.16)   // now: at market price
    expect(t.labels[6]).toBe('Today')
  })

  it('no activity: a flat week at today\'s total', () => {
    const t = portfolioTrend([], { USDC: 10, EURC: 1, cirBTC: 0 }, P, NOW)
    expect(new Set(t.values.map(v => v.toFixed(6)))).toEqual(new Set([(10 + 1.16).toFixed(6)]))
  })
})
