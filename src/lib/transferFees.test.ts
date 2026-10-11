import { describe, it, expect } from 'vitest'
import { ubFeeBreakdown, ubSpendAmount, ubSpendMargin, ubQuoteFees, ubSpendCost } from './transferFees'

// A real forwarded Base Sepolia → Arc quote (10 USDC claim, 2026-10-10): the
// signed burn intent's maxFee was 0.026389 = Base's Gateway gas fee (0.01)
// + the forwarding fee App Kit also lists on its own (0.016389). App Kit
// reports that maxFee as provider + gasFee.
const est = { fees: [
  { type: 'provider', token: 'USDC', amount: '0.0005' },
  { type: 'gasFee', token: 'USDC', amount: '0.025889' },
  { type: 'forwarder', token: 'USDC', amount: '0.016389' },
] }
const fees = ubQuoteFees(est)
const MAX_FEE = 0.026389

describe('Unified Balance fees', () => {
  it('the cost is the signed maxFee - the forwarding fee is not added again', () => {
    expect(ubSpendCost(fees)).toBeCloseTo(MAX_FEE, 9)
  })

  it('Receiver Gets is exactly what the send mints: deposit − maxFee − headroom', () => {
    const b = ubFeeBreakdown(10, fees)
    expect(b.receiverGets).toBeCloseTo(ubSpendAmount(10, MAX_FEE), 9)
    expect(b.receiverGets).toBeCloseTo(10 - MAX_FEE - ubSpendMargin(MAX_FEE), 9)
  })

  it('every row adds up: You Send − all rows = Receiver Gets, forwarding fee counted once', () => {
    const b = ubFeeBreakdown(10, fees)
    expect(b.forwarderFee).toBeCloseTo(0.016389, 9)
    expect(10 - (fees.providerFee + b.forwarderFee + b.networkFee)).toBeCloseTo(b.receiverGets, 9)
    expect(b.totalFee).toBeCloseTo(MAX_FEE + ubSpendMargin(MAX_FEE), 9)
  })

  it('a custom fee comes out of what is minted', () => {
    const b = ubFeeBreakdown(10, { ...fees, kitFee: 0.05 })
    expect(b.receiverGets).toBeCloseTo(ubSpendAmount(10, MAX_FEE) - 0.05, 9)
    expect(b.totalFee).toBeCloseTo(10 - b.receiverGets, 9)
  })

  it('USDC fees only; a total-only quote is used as the fee', () => {
    expect(ubSpendCost(ubQuoteFees({ fees: [{ type: 'gasFee', token: 'ETH', amount: '0.4' }, { type: 'gasFee', token: 'USDC', amount: '0.001' }] }))).toBeCloseTo(0.001, 9)
    expect(ubSpendCost(ubQuoteFees({ total: '0.02' }))).toBeCloseTo(0.02, 9)
  })

  it('headroom: 3% of the fee, 0.0005 – 0.01, and dust already there stands in for it', () => {
    expect(ubSpendMargin(0)).toBe(0.0005)
    expect(ubSpendMargin(0.1)).toBeCloseTo(0.003, 9)
    expect(ubSpendMargin(5)).toBe(0.01)
    expect(ubSpendMargin(5, 0.004)).toBeCloseTo(0.006, 9)
    expect(ubSpendMargin(5, 0.02)).toBe(0)
    // With enough dust nothing is kept back: exactly deposit − maxFee is sent.
    expect(ubSpendAmount(10, MAX_FEE, 0.02)).toBeCloseTo(10 - MAX_FEE, 9)
  })

  it('never negative', () => {
    expect(ubFeeBreakdown(0.01, fees).receiverGets).toBe(0)
    expect(ubSpendAmount(0.01, 1)).toBe(0)
  })
})
