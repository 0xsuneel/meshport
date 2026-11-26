import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
import { paymentsCsvRows } from './reports'
import type { MerchantPayment } from '@/lib/merchantPay'

const pay = (p: Partial<MerchantPayment>): MerchantPayment => ({
  id: 'p1', intentId: 'i1', chain: 'Arc_Testnet', txHash: '0xabc', from: '0xfrom', amount: 10, method: 'arc_direct',
  status: 'confirmed', customerUsername: 'ravi', createdAt: '2026-10-17T10:00:00Z', orderNumber: 'ORD-100042', matchedBy: 'customer', ...p,
})
const col = (rows: string[][], name: string) => rows.slice(1).map(r => r[rows[0].indexOf(name)])

describe('paymentsCsvRows', () => {
  const inr = [{ usdRate: 83, at: '2026-10-16T00:05:00Z' }, { usdRate: 84, at: '2026-10-17T12:00:00Z' }]

  it('values each payment at the rate in effect when it arrived', () => {
    const rows = paymentsCsvRows([pay({}), pay({ id: 'p2', amount: 2.5, createdAt: '2026-10-17T13:00:00Z' })], [], inr, 'INR')
    expect(col(rows, 'INR per USDC')).toEqual(['83.0000', '84.0000'])
    expect(col(rows, 'Amount (INR)')).toEqual(['830.00', '210.00'])
    expect(col(rows, 'Rate date')).toEqual(['2026-10-16', '2026-10-17'])
  })
  it('converts the refunded total at the same rate', () => {
    const rows = paymentsCsvRows([pay({})], [{ paymentId: 'p1', amount: 3 }, { paymentId: 'p1', amount: 1 }], inr, 'INR')
    expect(col(rows, 'Refunded (USDC)')).toEqual(['4.00'])
    expect(col(rows, 'Refunded (INR)')).toEqual(['332.00'])
    expect(col(rows, 'Status')).toEqual(['Partly refunded'])
  })
  it('marks a payment older than the rate history', () => {
    const rows = paymentsCsvRows([pay({ createdAt: '2026-10-01T10:00:00Z' })], [], inr, 'INR')
    expect(col(rows, 'Rate date')).toEqual(['2026-10-16 (earliest held)'])
  })
  it('leaves INR empty without rates', () => {
    const rows = paymentsCsvRows([pay({})], [], [], 'INR')
    expect(col(rows, 'Amount (INR)')).toEqual([''])
    expect(col(rows, 'Amount (USDC)')).toEqual(['10.00'])
  })
  it("uses the business's own currency, any country", () => {
    const eur = [{ usdRate: 0.92, at: '2026-10-16T00:05:00Z' }]
    const rows = paymentsCsvRows([pay({})], [], eur, 'EUR')
    expect(col(rows, 'EUR per USDC')).toEqual(['0.9200'])
    expect(col(rows, 'Amount (EUR)')).toEqual(['9.20'])
  })
  it('a USD business gets no conversion columns', () => {
    const rows = paymentsCsvRows([pay({})], [], [], 'USD')
    expect(rows[0].some(h => /per USDC|INR/.test(h))).toBe(false)
    expect(col(rows, 'Amount (USDC)')).toEqual(['10.00'])
  })
})
