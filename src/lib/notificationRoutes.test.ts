import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
import { urlFor } from './systemNotify'

const n = (type: string, body = '') => ({ id: 'x1', type, body })

describe('where a business notification opens', () => {
  it("the payer's own payment goes to Activity, not Business", () => {
    expect(urlFor(n('merchant_order_paid', 'You paid $1.00 USDC to Shop'))).toBe('/activity')
    expect(urlFor(n('merchant_payment_partial', 'You paid $2.00 of $5.00 USDC to Shop'))).toBe('/activity')
  })
  it("the business's notifications go to Business", () => {
    expect(urlFor(n('merchant_payment_received'))).toBe('/business?tab=payments')
    expect(urlFor(n('merchant_payment_partial', 'vrsun.arc paid $2.00 of $5.00 USDC'))).toBe('/business?tab=payments')
    expect(urlFor(n('business_daily_summary'))).toBe('/business')
    expect(urlFor(n('store_name_approved'))).toBe('/business')
    expect(urlFor(n('merchant_revoked'))).toBe('/merchant')
  })
})
