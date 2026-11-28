import { describe, it, expect } from 'vitest'
import { checkQr } from './qrCheck'

const me = { username: 'shop.arc', wallet: '0x2222222222222222222222222222222222222222' }

describe('Check a QR', () => {
  it('your Shop QR, a counter, a store and a payment link', () => {
    expect(checkQr('https://meshport.xyz/paylink/shop', me)).toMatchObject({ verdict: 'yours', kind: 'shop' })
    expect(checkQr('https://meshport.xyz/paylink/shop?store=s1&counter=c2', me)).toMatchObject({ verdict: 'yours', kind: 'counter', counterId: 'c2', storeId: 's1' })
    expect(checkQr('https://meshport.xyz/l/shop/veg-box', me)).toMatchObject({ verdict: 'yours', kind: 'link', slug: 'veg-box' })
    expect(checkQr('https://meshport.xyz/pay/SHOP.arc', me)).toMatchObject({ verdict: 'yours', kind: 'shop' })
  })
  it('your own wallet address', () => {
    expect(checkQr('ethereum:0x2222222222222222222222222222222222222222@5042002', me)).toMatchObject({ verdict: 'yours', kind: 'wallet' })
  })
  it("someone else's QR - a MeshPort shop or a plain wallet", () => {
    expect(checkQr('https://meshport.xyz/paylink/other', me)).toEqual({ verdict: 'not_yours', pays: 'other.arc', kind: 'meshport' })
    expect(checkQr('0x7a3f00000000000000000000000000000000c91e', me)).toEqual({ verdict: 'not_yours', pays: '0x7a3f…c91e', kind: 'wallet' })
  })
  it("anything else isn't a payment QR", () => {
    expect(checkQr('hello world', me).verdict).toBe('unknown')
    expect(checkQr('https://example.com/menu', me).verdict).toBe('unknown')
  })
})
