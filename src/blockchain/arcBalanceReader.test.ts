import { describe, it, expect, vi, beforeEach } from 'vitest'

// The chain's answer for each read, in order.
let chain = 1
vi.mock('@/lib/arcService', () => ({
  readUSDCBalanceOrThrow: async () => chain,
  readEURCBalanceOrThrow: async () => chain,
  readCirBtcBalanceOrThrow: async () => chain,
}))

import { getArcBalance } from './arcBalanceReader'

const W = '0x4cb2ff6492d51edfb54f0cff3b517d7f207d80a1'

describe('getArcBalance', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })

  it('past the TTL returns what the chain says now, not the previous read', async () => {
    chain = 1
    expect(await getArcBalance(W, 'USDC')).toBe(1)
    chain = 10 // funds arrive
    vi.setSystemTime(90_000) // the next poll
    expect(await getArcBalance(W, 'USDC')).toBe(10)
  })

  it('a { ttlMs: 0 } read after a payment is uncached', async () => {
    chain = 5
    expect(await getArcBalance(W, 'EURC')).toBe(5)
    chain = 2
    vi.setSystemTime(1_000)
    expect(await getArcBalance(W, 'EURC', { ttlMs: 0 })).toBe(2)
  })

  it('within the TTL simultaneous screens share one read', async () => {
    chain = 3
    expect(await getArcBalance(W, 'CIRBTC')).toBe(3)
    chain = 4
    vi.setSystemTime(2_000)
    expect(await getArcBalance(W, 'CIRBTC')).toBe(3)
  })
})
