// How bills and payment requests are named on screen.
import { describe, it, expect } from 'vitest'
import { displayOrderNumber, shortOrderNumber, orderKindOf, orderTitle, paymentOrderTag, parsePaymentOrderTag, paidTitleFromTag, orderCardPreview, shopFrom } from './orderLabels'

describe('displayOrderNumber', () => {
  it('shows the short #N form everywhere', () => {
    expect(displayOrderNumber('ORD-100001')).toBe('#1')
    expect(displayOrderNumber('ORD-100042')).toBe('#42')
    expect(displayOrderNumber('ORD-223456')).toBe('#123456')
  })
  it('leaves anything else alone', () => {
    expect(displayOrderNumber('ABC123')).toBe('ABC123')
    expect(displayOrderNumber(null)).toBe('')
  })
})

describe('shortOrderNumber', () => {
  it('drops the prefix and padding', () => {
    expect(shortOrderNumber('ORD-100001')).toBe('#1')
    expect(shortOrderNumber('ORD-100042')).toBe('#42')
    expect(shortOrderNumber('ORD-223456')).toBe('#123456')
  })
  it('leaves anything else alone', () => {
    expect(shortOrderNumber('ABC123')).toBe('ABC123')
    expect(shortOrderNumber(null)).toBe('')
  })
})

describe('orderTitle', () => {
  it('names each kind, waiting and paid', () => {
    expect(orderTitle('bill', 'ORD-100042')).toBe('Bill #42')
    expect(orderTitle('bill', 'ORD-100042', { paid: true })).toBe('Paid Bill #42')
    expect(orderTitle('request', 'ORD-100043')).toBe('Request #43')
    expect(orderTitle('request', 'ORD-100043', { paid: true })).toBe('Request Amount Paid #43')
    expect(orderTitle('merchant_request', 'ORD-100044')).toBe('Requested Payment #44')
    expect(orderTitle('merchant_request', 'ORD-100044', { paid: true })).toBe('Requested Payment Paid #44')
  })
  it('receiver side says Received', () => {
    expect(orderTitle('bill', 'ORD-100042', { received: true })).toBe('Bill #42 Received')
    expect(orderTitle('request', 'ORD-100043', { received: true })).toBe('Request #43 Amount Received')
    expect(orderTitle('merchant_request', 'ORD-100044', { received: true })).toBe('Requested #44 Payment Received')
    expect(orderTitle('request', 'ORD-100043', { received: true, short: true })).toBe('Request #43 Received')
    expect(paidTitleFromTag({ number: 'ORD-100042', kind: 'bill' }, false, true)).toBe('Bill #42 Received')
    expect(paidTitleFromTag({ number: 'ORD-100042', kind: null }, false, true)).toBe('#42 Received')
  })
  it('short form for history rows and card bands', () => {
    expect(orderTitle('bill', 'ORD-100042', { short: true })).toBe('Bill #42')
    expect(orderTitle('bill', 'ORD-100042', { paid: true, short: true })).toBe('Paid Bill #42')
    expect(orderTitle('bill', 'ORD-100042', { received: true, short: true })).toBe('Bill #42 Received')
    expect(orderTitle('request', 'ORD-100043', { short: true })).toBe('Request #43')
    expect(orderTitle('request', 'ORD-100043', { paid: true, short: true })).toBe('Request Paid · #43')
    expect(orderTitle('merchant_request', 'ORD-100044', { short: true })).toBe('Requested #44')
    expect(orderTitle('merchant_request', 'ORD-100044', { paid: true, short: true })).toBe('Requested Payment Paid · #44')
    expect(orderTitle('merchant_request', 'ORD-100044', { received: true, short: true })).toBe('Requested #44 Received')
    expect(paidTitleFromTag({ number: 'ORD-100042', kind: null }, true, true)).toBe('#42 Received')
    expect(paidTitleFromTag({ number: 'ORD-100042', kind: null }, true)).toBe('Paid #42')
    expect(orderTitle('bill', 'A1B2C3', { short: true })).toBe('Bill A1B2C3')
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
    expect(paidTitleFromTag(t)).toBe('Paid Bill #42')
    expect(paidTitleFromTag(parsePaymentOrderTag('Sent 3 USDC to bob.arc · Requested #ORD-100044')!)).toBe('Requested Payment Paid #44')
  })
  it('older "Order #" payments read "Paid #…"', () => {
    const t = parsePaymentOrderTag('Sent 3 USDC to bob.arc · Order #ORD-100042')!
    expect(t.kind).toBeNull()
    expect(paidTitleFromTag(t)).toBe('Paid #42')
  })
})

describe('orderCardPreview', () => {
  it('previews stored card text', () => {
    expect(orderCardPreview('💸 Payment request · Order #ORD-100010 · $5.3 USDC\nnote\nhttps://x')).toBe('💸 Request #10 · $5.3 USDC')
    expect(orderCardPreview('🧾 Bill · Order #ORD-100008 · $20.6 USDC\nShoes × 1')).toBe('🧾 Bill #8 · $20.6 USDC')
    expect(orderCardPreview('hello')).toBeNull()
  })
})

describe('Shop QR payments', () => {
  it('a Shop QR order is a payment, not a request', () => {
    expect(orderKindOf({ kind: 'request', personal: false, via: 'shop_qr' })).toBe('shop')
    expect(orderKindOf({ kind: 'request', personal: false, via: null })).toBe('merchant_request')
  })
  it('is titled Payment on both sides, with no order number', () => {
    expect(orderTitle('shop', 'ORD-100108')).toBe('Payment')
    expect(orderTitle('shop', 'ORD-100108', { paid: true })).toBe('Payment Paid')
    expect(orderTitle('shop', 'ORD-100108', { received: true, short: true })).toBe('Payment Received')
    expect(orderTitle('shop', 'ORD-100108', { paid: true, short: true })).toBe('Payment Paid')
  })
  it('round-trips through the chat payment tag', () => {
    const t = parsePaymentOrderTag('Sent 1 USDC to royal.arc' + paymentOrderTag('shop', 'ORD-100108'))!
    expect(t.kind).toBe('shop')
    expect(paidTitleFromTag(t, true, true)).toBe('Payment Received')
  })
})

describe('shopFrom', () => {
  it('names the business and its store when they differ', () => {
    expect(shopFrom('Royal Salons', 'Cutting Edge')).toBe('Royal Salons · Cutting Edge')
    expect(shopFrom('Royal Salons', 'royal salons')).toBe('Royal Salons')
    expect(shopFrom('Royal Salons', null)).toBe('Royal Salons')
    expect(shopFrom('Sunil R')).toBe('Sunil R')
  })
})
