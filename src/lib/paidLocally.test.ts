import { describe, it, expect, vi, afterEach } from 'vitest'
import { notePaidLocally, paidLocally, withLocalPayment, type PaymentView } from './merchantPay'

const view = (over: Partial<PaymentView> = {}) => ({ code: 'abc', amount: 10, received: 0, status: 'pending', ...over }) as PaymentView

afterEach(() => vi.useRealTimers())

describe('paid in this app, before the server confirms', () => {
  it('reads as paid at once, and the server reading wins once it agrees', () => {
    expect(withLocalPayment(view()).status).toBe('pending')
    notePaidLocally('abc')
    expect(paidLocally('abc')).toBe(true)
    const v = withLocalPayment(view({ received: 4, status: 'partially_paid' }))
    expect(v.status).toBe('paid')
    expect(v.received).toBe(10)
    // Other orders are untouched; a closed order is never shown as paid.
    expect(withLocalPayment(view({ code: 'other' })).status).toBe('pending')
    expect(withLocalPayment(view({ status: 'cancelled' })).status).toBe('cancelled')
  })

  it('stops counting after two minutes (the server decides from then on)', () => {
    vi.useFakeTimers()
    notePaidLocally('late')
    vi.advanceTimersByTime(2 * 60 * 1000 + 1)
    expect(paidLocally('late')).toBe(false)
    expect(withLocalPayment(view({ code: 'late' })).status).toBe('pending')
  })
})
