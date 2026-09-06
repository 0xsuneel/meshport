// src/lib/arcService.decimalAmount.test.ts
//
// Regression guard for reported bug: sending 0.00000001 cirBTC to another
// MeshPort user showed "Payment Failed — Value `1e-7` is not a valid decimal
// number." on Review Payment, even though the amount was well above cirBTC's
// 8-decimal minimum unit and well under the sender's balance.
//
// Root cause: sendEURC/sendCirBTC built viem's `parseUnits` input with
// `params.amount.toString()`. `params.amount` is a plain JS `number` (from
// PaySendPage.tsx's `parseFloat(amount)`), and `Number.prototype.toString()`
// switches to EXPONENTIAL notation for any magnitude below 1e-6 —
// `(0.00000001).toString()` is `'1e-8'`, not `'0.00000001'`. viem's
// `parseUnits` only accepts a plain decimal string and throws exactly this
// error ("Value `<x>` is not a valid decimal number.") on exponential input.
// sendUSDC never had this bug: it converts with plain arithmetic
// (`Math.round(amount * 1e6)`) instead of round-tripping through a string.
//
// Fix: `toPlainDecimalString()` uses `toLocaleString` with grouping disabled,
// which never emits exponential notation regardless of magnitude, capped to
// the token's own decimal precision.

import { describe, it, expect } from 'vitest'
import { toPlainDecimalString } from './arcService'

describe('toPlainDecimalString (sendEURC/sendCirBTC amount -> parseUnits input)', () => {
  it('does NOT reproduce the exact reported failure: 0.00000001 cirBTC (8 decimals)', () => {
    // Sanity check the bug even exists in plain JS, so this test isn't
    // vacuous.
    expect((0.00000001).toString()).toBe('1e-8')

    const result = toPlainDecimalString(0.00000001, 8)
    expect(result).toBe('0.00000001')
    // Never exponential notation, regardless of magnitude.
    expect(result).not.toMatch(/e[+-]/i)
  })

  it('handles other small magnitudes that also trip Number.prototype.toString()', () => {
    expect(toPlainDecimalString(0.0000001, 8)).toBe('0.0000001')
    expect(toPlainDecimalString(0.00000005, 8)).toBe('0.00000005')
    expect(toPlainDecimalString(0.000001, 6)).toBe('0.000001') // EURC's smallest unit
  })

  it('still formats ordinary, larger amounts correctly (no regression for the common case)', () => {
    expect(toPlainDecimalString(123.45, 6)).toBe('123.45')
    expect(toPlainDecimalString(10, 8)).toBe('10')
    expect(toPlainDecimalString(1.5, 2)).toBe('1.5')
  })

  it('caps to the token decimals rather than producing more precision than parseUnits could use', () => {
    // 6-decimal token (EURC) should never see more than 6 fractional digits.
    expect(toPlainDecimalString(1.2345678, 6)).toBe('1.234568')
  })

  it('rejects non-finite input instead of silently producing "NaN" or "Infinity" strings', () => {
    expect(() => toPlainDecimalString(NaN, 8)).toThrow()
    expect(() => toPlainDecimalString(Infinity, 8)).toThrow()
  })
})
