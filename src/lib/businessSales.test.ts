import { describe, it, expect } from 'vitest'
import { mergeSales, summarizeSales, salesSeries } from './businessSales'
import type { MerchantPayment, ChainReceipt } from './merchantPay'

const DAY = 86_400_000
const now = Date.parse('2026-10-22T12:00:00Z')
const pay = (id: string, amount: number, daysAgo: number, extra: Partial<MerchantPayment> = {}): MerchantPayment => ({
  id, intentId: 'i' + id, chain: 'Arc_Testnet', txHash: '0x' + id, from: '0x' + id.padStart(40, '1'), amount,
  method: 'link', status: 'collected', customerUsername: null, createdAt: new Date(now - daysAgo * DAY).toISOString(), orderNumber: null, matchedBy: null, ...extra,
})
const rcpt = (id: string, amount: number, from: string | null, extra: Partial<ChainReceipt> = {}): ChainReceipt => ({
  id, chain: 'Base_Sepolia', txHash: '0x' + id, from, amount, orderNumber: null, status: 'received', createdAt: new Date(now - DAY).toISOString(), convertedAt: null, ...extra,
})

describe('businessSales', () => {
  it('mergeSales adds receipts with no order and marks own transfers', () => {
    const own = '0x' + 'a'.repeat(40)
    const orders = [pay('o1', 10, 1, { chain: 'Base_Sepolia', txHash: '0xdup' })]
    const merged = mergeSales(orders, [rcpt('dup', 10, '0x' + 'b'.repeat(40), { txHash: '0xDUP' }), rcpt('r2', 5, '0x' + 'b'.repeat(40)), rcpt('r3', 7, own)], own)
    expect(merged.map(p => p.id).sort()).toEqual(['o1', 'rcpt_r2', 'rcpt_r3'])
    expect(merged.find(p => p.id === 'rcpt_r2')!.method).toBe('direct')
    expect(merged.find(p => p.id === 'rcpt_r3')!.method).toBe('own_transfer')
  })

  it('summarizeSales counts the window and compares with the one before', () => {
    const sales = [
      pay('a', 30, 1, { customerUsername: 'ravi' }), pay('b', 10, 2, { customerUsername: 'ravi' }), pay('c', 20, 3, { customerUsername: 'anu' }),
      pay('d', 20, 9, { customerUsername: 'ravi' }), // the week before
    ]
    const s = summarizeSales(sales, now - 7 * DAY, now)
    expect(s.total).toBe(60)
    expect(s.count).toBe(3)
    expect(s.customers).toBe(2)
    expect(s.average).toBe(20)
    expect(s.largest).toBe(30)
    expect(s.totalChange).toBe(200)
    expect(s.topCustomers[0]).toEqual({ name: 'ravi.arc', total: 40, count: 2 })
    expect(s.chains).toEqual([{ chain: 'Arc_Testnet', total: 60, share: 1 }])
  })

  it('summarizeSales: no change figure when the window before had nothing', () => {
    expect(summarizeSales([pay('a', 5, 1)], now - 7 * DAY, now).totalChange).toBeNull()
    expect(summarizeSales([], now - 7 * DAY, now)).toMatchObject({ total: 0, count: 0, peakHour: null })
  })

  it('salesSeries buckets amounts across the window', () => {
    const sales = [pay('a', 5, 6.5), pay('b', 3, 0.5), pay('c', 2, 0.2), pay('old', 9, 8)]
    expect(salesSeries(sales, now - 7 * DAY, now, 7)).toEqual([5, 0, 0, 0, 0, 0, 5])
  })
})
