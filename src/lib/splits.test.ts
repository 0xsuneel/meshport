import { describe, it, expect, vi } from 'vitest'
vi.mock('./supabase', () => ({ supabase: { rpc: vi.fn() } }))
import { equalShares, percentShares, sharesGap, isSettled, money, capShareInput } from './splits'

describe('split maths', () => {
  it('equal shares add up exactly; the payer keeps the extra cent', () => {
    expect(equalShares(25, 3)).toEqual([8.34, 8.33, 8.33])
    expect(sharesGap(25, equalShares(25, 3))).toBe(0)
    expect(equalShares(10, 4)).toEqual([2.5, 2.5, 2.5, 2.5])
    expect(equalShares(0.05, 3)).toEqual([0.03, 0.01, 0.01])
    expect(equalShares(0, 3)).toEqual([])
  })
  it('percentages: rounding cents go to the payer only when they make 100%', () => {
    expect(percentShares(25, [50, 25, 25])).toEqual([12.5, 6.25, 6.25])
    expect(percentShares(10, [33.33, 33.33, 33.34])).toEqual([3.34, 3.33, 3.33])
    expect(sharesGap(10, percentShares(10, [33.33, 33.33, 33.34]))).toBe(0)
    expect(sharesGap(10, percentShares(10, [50, 20]))).toBe(300)
  })
  it('gap in cents', () => {
    expect(sharesGap(25, [5, 12, 8])).toBe(0)
    expect(sharesGap(25, [5, 12])).toBe(800)
    expect(sharesGap(25, [5, 12, 9])).toBe(-100)
  })
  it('a typed share never goes above what is left', () => {
    expect(capShareInput('500', 17)).toEqual({ text: '17', capped: true })
    expect(capShareInput('12.5', 17)).toEqual({ text: '12.5', capped: false })
    expect(capShareInput('17', 17)).toEqual({ text: '17', capped: false })
    expect(capShareInput('150', 66.67)).toEqual({ text: '66.67', capped: true })
    expect(capShareInput('5', -3)).toEqual({ text: '0', capped: true })
    expect(capShareInput('', 10)).toEqual({ text: '', capped: false })
    expect(capShareInput('8.', 10)).toEqual({ text: '8.', capped: false })
  })
  it('settled and money', () => {
    expect(isSettled({ requests: 2, paidCount: 2 })).toBe(true)
    expect(isSettled({ requests: 2, paidCount: 1 })).toBe(false)
    expect(money(8.333)).toBe('$8.33')
  })
})
