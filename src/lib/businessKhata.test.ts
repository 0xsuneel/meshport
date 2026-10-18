import { describe, it, expect } from 'vitest'
import { khataOf, khataByCustomer, totalOutstanding, isOutstanding, type KhataOrder } from './businessKhata'

const now = Date.parse('2026-10-18T12:00:00Z')
const o = (p: Partial<KhataOrder>): KhataOrder => ({ customerUsername: 'ravi', amount: 10, received: 0, status: 'pending', expiresAt: null, dueDate: null, ...p })

describe('khataOf', () => {
  it('adds billed, paid and outstanding', () => {
    const k = khataOf([
      o({ amount: 10, received: 10, status: 'paid' }),
      o({ amount: 20, received: 5, status: 'partially_paid', dueDate: '2026-10-10' }),
      o({ amount: 7.5 }),
    ], now, '2026-10-18')
    expect(k).toEqual({ billed: 37.5, paid: 15, outstanding: 22.5, open: 2, overdue: 1 })
  })
  it('leaves out cancelled and expired orders except what was paid on them', () => {
    const k = khataOf([
      o({ status: 'cancelled' }),
      o({ status: 'cancelled', received: 4 }),
      o({ expiresAt: '2026-10-17T00:00:00Z' }),
      o({ status: 'expired', received: 2 }),
    ], now)
    expect(k).toEqual({ billed: 6, paid: 6, outstanding: 0, open: 0, overdue: 0 })
  })
  it('counts an overpaid order as paid in full, nothing outstanding', () => {
    expect(khataOf([o({ amount: 10, received: 12, status: 'paid' })], now)).toMatchObject({ billed: 10, paid: 10, outstanding: 0 })
  })
  it('avoids float drift', () => {
    expect(khataOf([o({ amount: 0.1 }), o({ amount: 0.2 })], now).outstanding).toBe(0.3)
  })
})

describe('khataByCustomer', () => {
  it('groups by username (any case, with or without .arc) and skips unnamed orders', () => {
    const m = khataByCustomer([o({ customerUsername: 'Ravi' }), o({ customerUsername: 'ravi.arc', amount: 5 }), o({ customerUsername: null }), o({ customerUsername: 'asha', amount: 3 })], now)
    expect([...m.keys()].sort()).toEqual(['u:asha', 'u:ravi'])
    expect(m.get('u:ravi')?.outstanding).toBe(15)
    expect(totalOutstanding(m)).toBe(18)
  })
})

describe('isOutstanding', () => {
  it('is false once paid in full or expired', () => {
    expect(isOutstanding(o({ received: 10, status: 'partially_paid' }), now)).toBe(false)
    expect(isOutstanding(o({ expiresAt: '2026-10-18T11:59:00Z' }), now)).toBe(false)
    expect(isOutstanding(o({}), now)).toBe(true)
  })
})

describe('khataOf · completed by the business', () => {
  it('counts a cash-completed order as paid in full', () => {
    const k = khataOf([{ customerUsername: 'a', amount: 10, received: 0, status: 'paid', expiresAt: null, completedByMerchant: true }])
    expect(k).toMatchObject({ billed: 10, paid: 10, outstanding: 0, open: 0 })
  })
})
