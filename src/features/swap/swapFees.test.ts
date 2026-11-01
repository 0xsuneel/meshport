import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
const { swapFeesText } = await import('./SwapPage')

describe('swap fees are shown in their own tokens', () => {
  it('never adds cirBTC / EURC amounts up as dollars', () => {
    expect(swapFeesText([{ amount: '0.00001', token: 'cirBTC' }, { amount: '0.0002', token: 'USDC' }])).toBe('~0.00001 cirBTC + ~0.0002 USDC')
    expect(swapFeesText([{ amount: '0.001', token: 'EURC' }, { amount: '0.002', token: 'EURC' }])).toBe('~0.003 EURC')
  })
  it('a fee given by token address is named by its token', () => {
    expect(swapFeesText([{ amount: '0.5', token: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a' }])).toBe('~0.5 EURC')
  })
  it('no fees: 0', () => { expect(swapFeesText([])).toBe('0') })
})
