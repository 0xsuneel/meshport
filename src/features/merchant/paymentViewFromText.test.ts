import { describe, it, expect } from 'vitest'
import { paymentViewFromText } from './MerchantPaymentCard'

describe('paymentViewFromText', () => {
  it('bill with order number, items and note', () => {
    const v = paymentViewFromText('993c9ae689', '🧾 Bill · Order #ORD-100008 · $20.6 USDC\nShoes × 1, Shirt × 1, Shoap × 2\nPlease Make Payment\nhttps://meshport.xyz/pay/r/993c9ae689')!
    expect(v.orderNumber).toBe('ORD-100008'); expect(v.amount).toBe(20.6); expect(v.kind).toBe('invoice')
    expect(v.items?.map(i => [i.name, i.qty])).toEqual([['Shoes', 1], ['Shirt', 1], ['Shoap', 2]])
    expect(v.note).toBe('Please Make Payment')
  })
  it('payment request', () => {
    const v = paymentViewFromText('f5bccadb6b', '💸 Payment request · Order #ORD-100010 · $5.3 USDC\nShoes bill\nhttps://meshport.xyz/pay/r/f5bccadb6b')!
    expect(v.orderNumber).toBe('ORD-100010'); expect(v.amount).toBe(5.3); expect(v.kind).toBe('request'); expect(v.note).toBe('Shoes bill'); expect(v.items).toBeNull()
  })
  it('old bill without order number', () => {
    const v = paymentViewFromText('b1cf18e2fc', '🧾 Bill · $4.5 USDC\nTea × 3, Coffee × 5\nOrder 2\nhttps://meshport.xyz/pay/r/b1cf18e2fc')!
    expect(v.orderNumber).toBeNull(); expect(v.amount).toBe(4.5); expect(v.items?.length).toBe(2); expect(v.note).toBe('Order 2')
  })
  it('plain link text is not a card', () => {
    expect(paymentViewFromText('abc123', 'pay here https://meshport.xyz/pay/r/abc123')).toBeNull()
  })
})
