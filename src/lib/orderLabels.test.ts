// How bills and payment requests are named on screen.
import { describe, it, expect } from 'vitest'
import { displayOrderNumber, orderKindOf, orderTitle, paymentOrderTag, parsePaymentOrderTag, paidTitleFromTag, orderCardPreview } from './orderLabels'

describe('displayOrderNumber', () => {
  it('shows stored numbers from 00001', () => {
    expect(displayOrderNumber('ORD-100001')).toBe('ORD-00001')
    expect(displayOrderNumber('ORD-100042')).toBe('ORD-00042')
    expect(displayOrderNumber('ORD-223456')).toBe('ORD-123456')
  })
  it('leaves anything else alone', () => {
    expect(displayOrderNumber('ABC123')).toBe('ABC123')
    expect(displayOrderNumber(null)).toBe('')
  })
})

describe('orderTitle', () => {
  it('names each kind, waiting and paid', () => {
    expect(orderTitle('bill', 'ORD-100042')).toBe('Bill ORD-00042')
    expect(orderTitle('bill', 'ORD-100042', { paid: true })).toBe('Paid Bill ORD-00042')
    expect(orderTitle('request', 'ORD-100043')).toBe('Request ORD-00043')
    expect(orderTitle('request', 'ORD-100043', { paid: true })).toBe('Request Amount Paid ORD-00043')
    expect(orderTitle('merchant_request', 'ORD-100044')).toBe('Requested Payment ORD-00044')
    expect(orderTitle('merchant_request', 'ORD-100044', { paid: true })).toBe('Requested Payment Paid ORD-00044')
  })
  it('short form for card bands', () => {
    expect(orderTitle('request', 'ORD-100043', { paid: true, short: true })).toBe('Request Paid · ORD-00043')
    expect(orderTitle('merchant_request', 'ORD-100044', { paid: true, short: true })).toBe('Requested Payment Paid · ORD-00044')
  })
  it('kind: bill, normal user request, merchant request', () => {
    expect(orderKindOf({ kind: 'invoice' })).toBe('bill')
    expect(orderKindOf({ kind: 'request', personal: true })).toBe('request')
    expect(orderKindOf({ kind: 'request', personal: false })).toBe('merchant_request')
    expect(orderKindOf({ kind: 'request' })).toBe('request')
  })
})

describe('payment tags', () => {
  it('round-trips the kind on a payment message', () => {
    const msg = 'Sent 3 USDC to bob.arc' + paymentOrderTag('bill', 'ORD-100042')
    expect(msg).toBe('Sent 3 USDC to bob.arc · Bill #ORD-100042')
    const t = parsePaymentOrderTag(msg)!
    expect(t).toMatchObject({ number: 'ORD-100042', kind: 'bill' })
    expect(paidTitleFromTag(t)).toBe('Paid Bill ORD-00042')
    expect(paidTitleFromTag(parsePaymentOrderTag('Sent 3 USDC to bob.arc · Requested #ORD-100044')!)).toBe('Requested Payment Paid ORD-00044')
  })
  it('older "Order #" payments read "Paid ORD-…"', () => {
    const t = parsePaymentOrderTag('Sent 3 USDC to bob.arc · Order #ORD-100042')!
    expect(t.kind).toBeNull()
    expect(paidTitleFromTag(t)).toBe('Paid ORD-00042')
  })
})

describe('orderCardPreview', () => {
  it('previews stored card text', () => {
    expect(orderCardPreview('💸 Payment request · Order #ORD-100010 · $5.3 USDC\nnote\nhttps://x')).toBe('💸 Request ORD-00010 · $5.3 USDC')
    expect(orderCardPreview('🧾 Bill · Order #ORD-100008 · $20.6 USDC\nShoes × 1')).toBe('🧾 Bill ORD-00008 · $20.6 USDC')
    expect(orderCardPreview('hello')).toBeNull()
  })
})
