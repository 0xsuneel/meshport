import { describe, it, expect } from 'vitest'
import { keccak256, toBytes } from 'viem'
import {
  groupRefunds, refundedSum, remainingAfter, isFullyRefunded, canRefundMore, refundState, netPayments, extraLeft, refundRefText, MIN_REFUND,
} from './refundTotals'

const r = (paymentId: string, amount: number, createdAt = '2026-10-18T10:00:00Z') => ({ paymentId, amount, createdAt })

describe('refund totals (several refunds per payment)', () => {
  it('groups refunds per payment, oldest first, and sums them', () => {
    const m = groupRefunds([r('a', 2, '2026-10-18T12:00:00Z'), r('b', 1), r('a', 3, '2026-10-18T09:00:00Z')])
    expect(m.get('a')!.map(x => x.amount)).toEqual([3, 2])
    expect(refundedSum(m.get('a'))).toBe(5)
    expect(refundedSum(m.get('missing'))).toBe(0)
  })

  it('sums without float drift', () => {
    expect(refundedSum([{ amount: 0.1 }, { amount: 0.2 }])).toBe(0.3)
    expect(remainingAfter(10, 9.99)).toBe(0.01)
  })

  it('remaining never goes below zero', () => {
    expect(remainingAfter(10, 4)).toBe(6)
    expect(remainingAfter(10, 10)).toBe(0)
    expect(remainingAfter(10, 12)).toBe(0)
  })

  it('refund stays available while at least $0.01 is left', () => {
    expect(canRefundMore(10, 0)).toBe(true)
    expect(canRefundMore(10, 9.99)).toBe(true)
    expect(canRefundMore(10, 9.995)).toBe(false)
    expect(canRefundMore(10, 10)).toBe(false)
    expect(MIN_REFUND).toBe(0.01)
  })

  it('full vs partly refunded', () => {
    expect(isFullyRefunded(10, 0)).toBe(false)
    expect(isFullyRefunded(10, 10)).toBe(true)
    expect(refundState(10, 4)).toEqual({ refunded: 4, remaining: 6, full: false, partial: true })
    expect(refundState(10, 10)).toEqual({ refunded: 10, remaining: 0, full: true, partial: false })
    expect(refundState(10, 0).partial).toBe(false)
  })

  it('nets payments by everything refunded and drops fully refunded ones', () => {
    const pays = [{ id: 'a', amount: 10 }, { id: 'b', amount: 5 }, { id: 'c', amount: 7 }]
    const by = groupRefunds([r('a', 3), r('a', 2), r('b', 5)])
    const net = netPayments(pays, id => refundedSum(by.get(id)))
    expect(net).toEqual([{ id: 'a', amount: 5 }, { id: 'c', amount: 7 }])
    expect(net.reduce((s, p) => s + p.amount, 0)).toBe(12)
    // The input is not changed.
    expect(pays[0].amount).toBe(10)
  })

  it('extra on an overpaid order shrinks with refunds and does not block later ones', () => {
    expect(extraLeft(2, 0)).toBe(2)
    expect(extraLeft(2, 1.5)).toBe(0.5)
    expect(extraLeft(2, 2)).toBe(0)
    // After refunding the extra, the payment itself can still be refunded.
    expect(canRefundMore(12, 2)).toBe(true)
  })

  it('contract references: refund 1 keeps the old reference, later ones are distinct', () => {
    const id = '1b4e28ba-2fa1-11d2-883f-0016d3cca427'
    expect(refundRefText(id, 1)).toBe(id)
    expect(refundRefText(id, 2)).toBe(`${id}:2`)
    const refs = [1, 2, 3].map(n => keccak256(toBytes(refundRefText(id, n))))
    expect(refs[0]).toBe(keccak256(toBytes(id)))
    expect(new Set(refs).size).toBe(3)
  })
})
