import { describe, it, expect } from 'vitest'
import { isShopPayment } from './recentContacts'

describe('isShopPayment', () => {
  it('flags Shop QR and other business payments', () => {
    expect(isShopPayment({ merchantVia: 'shop_qr', merchantPayment: true, merchantPersonal: false })).toBe(true)
    expect(isShopPayment({ merchantPayment: true })).toBe(true)
  })
  it('keeps payments to people and to a business personal account', () => {
    expect(isShopPayment({ via: 'pay', toUsername: 'vrsun.arc' })).toBe(false)
    expect(isShopPayment({ merchantVia: 'shop_qr', merchantPersonal: true })).toBe(false)
    expect(isShopPayment(null)).toBe(false)
  })
})
