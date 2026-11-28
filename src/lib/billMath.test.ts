// Bills (27 Nov): the composer's sums must match what the database stores
// (merchant_payment_intents_before_write) - discount, then tax in cents.
import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
import { billBreakdown, billLines } from './merchantPay'
import { contactOf, shareChannels } from './shareLinks'

const items = [{ name: 'Coffee', qty: 2, price: 3.5 }, { name: 'Sandwich', qty: 1, price: 6 }]

describe('bill sums', () => {
  it('discount % then tax on top, in cents (as the server: 12.29)', () => {
    const b = billBreakdown(items, { discountType: 'percent', discountValue: 10, taxPercent: 5 })
    expect(b).toMatchObject({ subtotal: 13, discount: 1.3, tax: 0.59, total: 12.29, inclusive: false })
  })
  it('an amount discount with tax already in the prices (as the server: 100, tax 4.76)', () => {
    const b = billBreakdown([{ name: 'A', qty: 1, price: 105 }], { discountType: 'amount', discountValue: 5, taxPercent: 5, taxInclusive: true })
    expect(b).toMatchObject({ subtotal: 105, discount: 5, tax: 4.76, total: 100, inclusive: true })
  })
  it('an amount discount never goes past the subtotal', () => {
    expect(billBreakdown(items, { discountType: 'amount', discountValue: 99 }).discount).toBe(13)
  })
  it('no discount or tax: the items alone', () => {
    expect(billBreakdown(items)).toMatchObject({ subtotal: 13, discount: 0, tax: 0, total: 13 })
  })
})

describe('bill lines', () => {
  it('stored details: subtotal, discount, named tax, total', () => {
    const lines = billLines(items, 12.29, 5, { subtotal: 13, discountType: 'percent', discountValue: 10, discountAmount: 1.3,
      taxName: 'VAT', taxInclusive: false, taxAmount: 0.59, billToName: null, footer: null, storeAddress: null })
    expect(lines.map(l => [l.label, l.amount])).toEqual([['Subtotal', 13], ['Discount 10%', -1.3], ['VAT 5%', 0.59], ['Total', 12.29]])
  })
  it('an older bill (tax rate only): tax from the total', () => {
    const lines = billLines([{ name: 'Old', qty: 1, price: 10 }], 11.8, 18, null)
    expect(lines.map(l => [l.label, l.amount])).toEqual([['Subtotal', 10], ['Tax 18%', 1.8], ['Total', 11.8]])
  })
  it('no tax or discount: just the total', () => {
    expect(billLines(items, 13, 0, null).map(l => l.kind)).toEqual(['total'])
  })
})

describe('sending a bill to someone not on MeshPort', () => {
  it('reads a phone or an email', () => {
    expect(contactOf('+971 50 123 4567')).toEqual({ phone: '971501234567' })
    expect(contactOf('riya@example.com')).toEqual({ email: 'riya@example.com' })
    expect(contactOf('Riya')).toEqual({})
  })
  it('addresses WhatsApp, SMS and email to them', () => {
    const [wa, sms] = shareChannels('Bill', 'Pay here', '+971501234567')
    expect(wa.href).toBe('https://wa.me/971501234567?text=Pay%20here')
    expect(sms.href).toBe('sms:+971501234567?&body=Pay%20here')
    expect(shareChannels('Bill', 'Pay', 'riya@example.com')[2].href).toBe('mailto:riya%40example.com?subject=Bill&body=Pay')
  })
})
