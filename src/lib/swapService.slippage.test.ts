// The slippage a swap uses is the one the person picked (1% / 3% / 5%) -
// it used to be floored at 3%, so picking 1% did nothing.
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/accountLockRule', () => ({ assertAccountUnlocked: () => {} }))
vi.mock('./perfTrace', () => ({ reportSwap: () => {} }))

describe('effectiveSlippageBps', () => {
  it('uses the tolerance the person picked, including 1%', async () => {
    const { effectiveSlippageBps } = await import('./swapService')
    expect(effectiveSlippageBps(100)).toBe(100)
    expect(effectiveSlippageBps(300)).toBe(300)
    expect(effectiveSlippageBps(500)).toBe(500)
  })

  it('falls back to the screen default (5%) when there is no choice', async () => {
    const { effectiveSlippageBps } = await import('./swapService')
    for (const v of [undefined, null, 0, -50, 'x', NaN]) expect(effectiveSlippageBps(v), String(v)).toBe(500)
  })

  it('keeps a value from elsewhere between 0.1% and 50%', async () => {
    const { effectiveSlippageBps } = await import('./swapService')
    expect(effectiveSlippageBps(1)).toBe(10)
    expect(effectiveSlippageBps(99_999)).toBe(5000)
    expect(effectiveSlippageBps('150')).toBe(150)
  })
})
