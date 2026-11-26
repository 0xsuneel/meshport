import { describe, it, expect } from 'vitest'
import { PAY_MAX_FEE, payFeeCapWithin } from './payFee'

const gwei = (n: number) => BigInt(Math.round(n * 1e9))

describe('payFeeCapWithin', () => {
  it('keeps a normal cap as it is', () => {
    expect(payFeeCapWithin(gwei(50), 52_908n)).toBe(gwei(50))
    expect(payFeeCapWithin(gwei(435.5), 52_908n)).toBe(gwei(435.5))
  })
  it('lowers a cap from a high gas-price reading so the send fits what was approved', () => {
    const gas = 52_908n
    const cap = payFeeCapWithin(gwei(600), gas)
    expect(cap * gas <= PAY_MAX_FEE).toBe(true)
    expect(cap > gwei(400)).toBe(true) // still far above Arc's ~20 gwei base fee
  })
})
