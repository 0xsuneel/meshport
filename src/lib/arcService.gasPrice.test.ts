import { describe, it, expect, vi } from 'vitest'

// Fee estimates on the Pay / Swap / Transfer screens: one gas-price read
// shared for 15 s, through one reused client - a failure is never cached.
let fail = false
const getGasPrice = vi.fn(async () => { if (fail) throw new Error('rpc down'); return 25_000_000_000n })
const createPublicClient = vi.fn(() => ({ getGasPrice }))
vi.mock('viem', async () => ({ ...(await vi.importActual<typeof import('viem')>('viem')), createPublicClient: () => createPublicClient() }))

import { estimateTransferFee, estimateUbDepositGas } from './arcService'

describe('fee estimates', () => {
  it('screens opening together share one gas-price read and one client', async () => {
    const [a, b, c] = await Promise.all([estimateTransferFee(1), estimateTransferFee(1, true), estimateUbDepositGas()])
    expect(a).toBeCloseTo(21000 * 25e9 / 1e18)
    expect(b).toBeCloseTo(65000 * 25e9 / 1e18)
    expect(c).toBeGreaterThan(0)
    expect(getGasPrice).toHaveBeenCalledTimes(1)
    expect(createPublicClient).toHaveBeenCalledTimes(1)
  })

  it('a failed read is not cached: the fallback fee now, a fresh read next time', async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 60_000) // past the 15 s window
    fail = true
    expect(await estimateTransferFee(1)).toBe(0.0001)
    fail = false
    expect(await estimateTransferFee(1)).toBeCloseTo(21000 * 25e9 / 1e18)
    expect(getGasPrice).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })
})
