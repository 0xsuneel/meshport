import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
import { shopSubline, shopTitle } from './shop'

describe('shopSubline - under a shop\'s name, never its username', () => {
  it('is headed by the store, with the category and brand under it', () => {
    const s = { businessName: 'Shop', storeName: 'Sharma Jeneral Store', category: 'Retail store' }
    expect(shopTitle(s)).toBe('Sharma Jeneral Store')
    expect(shopSubline(s)).toBe('Retail store · Shop')
  })
  it("doesn't repeat a store named like the business, or show a missing category", () => {
    const s = { businessName: 'Royal Salons', storeName: 'royal salons', category: 'Salon / Beauty' }
    expect(shopTitle(s)).toBe('royal salons')
    expect(shopSubline(s)).toBe('Salon / Beauty')
    expect(shopTitle({ businessName: 'Royal Salons', storeName: null })).toBe('Royal Salons')
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
