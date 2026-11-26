import { describe, it, expect, vi } from 'vitest'

vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key')

describe('"Pay again" from history', () => {
  it('a Shop QR payment goes back through the shop page (with its store)', async () => {
    const { payAgainUrl } = await import('./ActivityPage')
    expect(payAgainUrl('shop', '0xabc', { merchantVia: 'shop_qr', merchantStore: 'st_1' })).toBe('/paylink/shop?store=st_1')
    expect(payAgainUrl('shop', '0xabc', { merchantVia: 'shop_qr' })).toBe('/paylink/shop')
  })
  it('anything else opens Pay as before', async () => {
    const { payAgainUrl } = await import('./ActivityPage')
    expect(payAgainUrl('alice', '0xabc', {})).toBe('/pay?to=' + encodeURIComponent('alice|0xabc'))
    expect(payAgainUrl(null, '0xabc', { merchantVia: 'shop_qr' })).toBe('/pay?to=0xabc')
  })
})
