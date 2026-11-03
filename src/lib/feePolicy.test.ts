import { describe, it, expect } from 'vitest'
import { CROSS_CHAIN_FEE, SWAP_FEE, usdRule, meshportFee, gasFloor, feeAcceptable, arcWeiToUsdcUnits } from './feePolicy'

// MeshPort's fee rule (lib/feePolicy): percentage, min, cap - never below gas × 1.15.
const usdc = usdRule(CROSS_CHAIN_FEE, 6)
const $ = (n: number) => BigInt(Math.round(n * 1e6))

describe('MeshPort fee rule', () => {
  it('cross-chain: 0.2%, min $0.05, cap $5', () => {
    expect(meshportFee($(5), 0n, usdc)).toBe($(0.05))       // 0.2% = $0.01 → minimum
    expect(meshportFee($(100), 0n, usdc)).toBe($(0.2))
    expect(meshportFee($(1000), 0n, usdc)).toBe($(2))
    expect(meshportFee($(10_000), 0n, usdc)).toBe($(5))     // cap
  })

  it('never below the live gas × 1.15 - even above the cap', () => {
    expect(meshportFee($(10), $(0.2), usdc)).toBe($(0.23))  // gas $0.20 → $0.23, above the $0.05 minimum
    expect(meshportFee($(10_000), $(8), usdc)).toBe($(9.2)) // gas $8 → $9.20, above the $5 cap
    expect(gasFloor(100n)).toBe(115n)
    expect(gasFloor(1n)).toBe(2n)                            // rounded up
  })

  it('a token rule at its price: min / cap in the token', () => {
    const eurc = usdRule(CROSS_CHAIN_FEE, 6, 1.08)
    expect(eurc.min).toBe(46_296n)                           // $0.05 / 1.08
    expect(eurc.cap).toBe(4_629_630n)                        // $5 / 1.08
    const btc = usdRule(CROSS_CHAIN_FEE, 8, 100_000)
    expect(btc.cap).toBe(5_000n)                             // $5 at $100k = 0.00005 BTC
  })

  it('swap: 0.35%, cap $10, no minimum', () => {
    const r = usdRule(SWAP_FEE, 6)
    expect(meshportFee($(100), 0n, r)).toBe($(0.35))
    expect(meshportFee($(10_000), 0n, r)).toBe($(10))
  })

  it('the relayer accepts a fee down to 90% of its own quote - never below its gas', () => {
    expect(feeAcceptable($(0.18), $(0.2), $(0.05))).toBe(true)
    expect(feeAcceptable($(0.17), $(0.2), $(0.05))).toBe(false)
    expect(feeAcceptable($(0.2), $(0.2), $(0.21))).toBe(false) // gas jumped above it: re-quote
  })

  it('Arc gas: wei → USDC units, rounded up', () => {
    expect(arcWeiToUsdcUnits(1n)).toBe(1n)
    expect(arcWeiToUsdcUnits(6_000_000_000_000_000n)).toBe(6000n) // 0.006 USDC
  })
})
