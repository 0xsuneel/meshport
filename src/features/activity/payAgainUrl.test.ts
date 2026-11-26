import { describe, it, expect, vi } from 'vitest'

vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key')

describe('"Pay again" from history', () => {
  it('a Shop QR payment goes back through the shop page (with its store)', async () => {
    const { payAgainUrl } = await import('./ActivityPage')
    const id = '895bbfd4-00b3-4af2-8319-9dc636ff0161'
    expect(payAgainUrl('shop', '0xabc', { merchantVia: 'shop_qr', merchantStoreId: id, merchantStore: 'Main' })).toBe(`/paylink/shop?store=${id}`)
    // Older payer rows kept the id in merchantStore.
    expect(payAgainUrl('shop', '0xabc', { merchantVia: 'shop_qr', merchantStore: id })).toBe(`/paylink/shop?store=${id}`)
    // The server fills merchantStore with the store's NAME - never sent as an id.
    expect(payAgainUrl('shop', '0xabc', { merchantVia: 'shop_qr', merchantStore: 'Royal Salons' })).toBe('/paylink/shop')
    expect(payAgainUrl('shop', '0xabc', { merchantVia: 'shop_qr' })).toBe('/paylink/shop')
  })
  it('names the shop as it was when paid (business · branch)', async () => {
    const { shopNameOf } = await import('./ActivityPage')
    expect(shopNameOf({ merchantName: 'Royal Salons', merchantStore: 'Cutting Edge' })).toBe('Royal Salons · Cutting Edge')
    expect(shopNameOf({ merchantName: 'Shop', merchantStore: 'Shop' })).toBe('Shop')
    expect(shopNameOf({ merchantName: 'Shop', merchantStore: '895bbfd4-00b3-4af2-8319-9dc636ff0161' })).toBe('Shop')
    // The business's own label for the store, even before customers see it.
    expect(shopNameOf({ merchantName: 'Shop', merchantStore: null, merchantStoreLabel: 'Andheri Branch' })).toBe('Shop · Andheri Branch')
  })
  it('anything else opens Pay as before', async () => {
    const { payAgainUrl } = await import('./ActivityPage')
    expect(payAgainUrl('alice', '0xabc', {})).toBe('/pay?to=' + encodeURIComponent('alice|0xabc'))
    expect(payAgainUrl(null, '0xabc', { merchantVia: 'shop_qr' })).toBe('/pay?to=0xabc')
  })
})
