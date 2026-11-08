import { describe, it, expect, vi } from 'vitest'
vi.mock('@/blockchain/chains', () => ({ FORWARDER_MINT_FAILING_SDK_CHAINS: [], forwarderMintFailing: () => false, noteForwarderMintFailed: () => {} }))
const { floorUsdc } = await import('./ubClaim')

describe('floorUsdc', () => {
  it('keeps whole base units that float math would drop', () => {
    expect(2.01 * 1e6).toBeLessThan(2010000) // the float error this guards against
    expect(floorUsdc(2.01)).toBe(2.01)
    expect(floorUsdc(0.1 + 0.2)).toBe(0.3)
  })
  it('still rounds down, never up past the amount', () => {
    expect(floorUsdc(1.0000009)).toBe(1)
    expect(floorUsdc(4.9999999)).toBe(4.999999)
    expect(floorUsdc(0)).toBe(0)
    expect(floorUsdc(-1)).toBe(0)
    expect(floorUsdc(NaN)).toBe(0)
  })
})
