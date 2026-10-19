import { describe, it, expect } from 'vitest'
import { invoiceBreakdown, invoiceTotal } from './merchantPay'

const items = (...xs: [string, number, number][]) => xs.map(([name, qty, price]) => ({ name, qty, price }))

describe('invoiceBreakdown', () => {
  it('no tax: total equals subtotal', () => {
    const b = invoiceBreakdown(items(['A', 2, 50]))
    expect(b).toEqual({ subtotal: 100, tax: 0, total: 100 })
  })
  it('adds tax to the subtotal', () => {
    expect(invoiceBreakdown(items(['A', 1, 100]), 18)).toEqual({ subtotal: 100, tax: 18, total: 118 })
    expect(invoiceBreakdown(items(['A', 1, 200]), 5)).toEqual({ subtotal: 200, tax: 10, total: 210 })
  })
  it('matches invoiceTotal for the subtotal and rounds tax to 6dp', () => {
    const its = items(['A', 3, 3.33], ['B', 1, 0.01])
    const sub = invoiceTotal(its) // 9.99 + 0.01 = 10.00
    const b = invoiceBreakdown(its, 2.5)
    expect(b.subtotal).toBe(sub)
    expect(b.total).toBeCloseTo(sub * 1.025, 6)
    expect(Number((b.subtotal + b.tax).toFixed(6))).toBe(b.total)
  })
  it('clamps the rate to 0..100', () => {
    expect(invoiceBreakdown(items(['A', 1, 100]), -5).total).toBe(100)
    expect(invoiceBreakdown(items(['A', 1, 100]), 150).total).toBe(200)
  })
})
