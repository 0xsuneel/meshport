import { describe, it, expect } from 'vitest'
import { amountFontSize } from './amountFontSize'

describe('amountFontSize', () => {
  it('keeps the base size for a short, normal amount', () => {
    expect(amountFontSize('123.45', 34)).toBe(34)
    expect(amountFontSize('', 34)).toBe(34)
  })

  it('shrinks gradually once the value passes the comfortable length', () => {
    const short = amountFontSize('123.45', 34)
    const cirbtc = amountFontSize('0.00004226', 34) // 10 chars -- a realistic cirBTC amount
    const longer = amountFontSize('123456.789', 34) // 10 chars, same length -- same shrink
    expect(cirbtc).toBeLessThan(short)
    expect(cirbtc).toBe(longer)
  })

  it('never shrinks below the floor, even for a very long value', () => {
    const size = amountFontSize('0.000000000000001234', 34)
    expect(size).toBeGreaterThanOrEqual(Math.round(34 * 0.4))
  })

  it('respects a custom minSize', () => {
    const size = amountFontSize('0.000000000000001234', 34, 20)
    expect(size).toBeGreaterThanOrEqual(20)
  })
})
