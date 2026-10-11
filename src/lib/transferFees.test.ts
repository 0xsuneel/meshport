import { describe, it, expect } from 'vitest'
import { ubFeeBreakdown, ubSpendAmount, ubSpendMargin } from './transferFees'

const fees = { providerFee: 0.02, gasFee: 0.01, kitFee: 0, forwarderFee: 0.2 }

describe('Unified Balance transfer fees', () => {
  it('Receiver Gets is exactly what the send mints: spend − kit − forwarder', () => {
    const b = ubFeeBreakdown(10, fees)
    const minted = ubSpendAmount(10, b.spendOverhead) - fees.kitFee - fees.forwarderFee
    expect(b.receiverGets).toBeCloseTo(minted, 9)
  })

  it('every fee comes out of the amount: You Send − all rows = Receiver Gets', () => {
    const b = ubFeeBreakdown(10, { ...fees, kitFee: 0.05 })
    expect(10 - (0.02 + 0.05 + 0.2 + b.networkFee)).toBeCloseTo(b.receiverGets, 9)
    expect(b.totalFee).toBeCloseTo(10 - b.receiverGets, 9)
  })

  it('no longer overstates: Gateway fee + gas are taken from the amount', () => {
    const b = ubFeeBreakdown(10, fees)
    expect(b.receiverGets).toBeLessThan(10 - fees.kitFee - fees.forwarderFee) // what it used to promise
  })

  it('margin: 3% of the Gateway fee + gas, 0.0005 – 0.01', () => {
    expect(ubSpendMargin(0)).toBe(0.0005)
    expect(ubSpendMargin(0.1)).toBeCloseTo(0.003, 9)
    expect(ubSpendMargin(5)).toBe(0.01)
  })

  it('never negative', () => {
    expect(ubFeeBreakdown(0.1, { ...fees, forwarderFee: 1 }).receiverGets).toBe(0)
    expect(ubSpendAmount(0.01, 1)).toBe(0)
  })
})
