import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
import { shopSubline } from './shop'

describe('shopSubline - under a shop\'s name, never its username', () => {
  it('says what kind of business and which branch', () => {
    expect(shopSubline({ businessName: 'Shop', storeName: 'Sharma Jeneral Store', category: 'Restaurant / Café' })).toBe('Restaurant / Café · Sharma Jeneral Store')
  })
  it("leaves out a branch named like the business, and a missing category", () => {
    expect(shopSubline({ businessName: 'Royal Salons', storeName: 'royal salons', category: 'Salon / Beauty' })).toBe('Salon / Beauty')
    expect(shopSubline({ businessName: 'Royal Salons', storeName: null, category: null })).toBe('')
  })
})

describe('merchant category codes', () => {
  it('every category has a 4-digit code', async () => {
    const { BUSINESS_CATEGORIES, businessMcc } = await import('./businessCategories')
    for (const c of BUSINESS_CATEGORIES) expect(businessMcc(c)).toMatch(/^\d{4}$/)
    expect(businessMcc('Restaurant / Café')).toBe('5812')
    expect(businessMcc('Grocery / Supermarket')).toBe('5411')
    expect(businessMcc(null)).toBe('5999')
  })
})
