// Business → numbers worked out from the store's own payments: day-over-day
// trend, sales by hour, and the CSV export. Runs on this device only.
import type { MerchantPayment } from '@/lib/merchantPay'
import { chainLabel } from './settlement'

const sameDay = (iso: string, d: Date) => new Date(iso).toDateString() === d.toDateString()

/** Today vs yesterday, in percent; null when yesterday had no sales. */
export function dayTrend(payments: MerchantPayment[]): number | null {
  const today = new Date(), yesterday = new Date(Date.now() - 86_400_000)
  const sum = (d: Date) => payments.filter(p => sameDay(p.createdAt, d)).reduce((s, p) => s + p.amount, 0)
  const before = sum(yesterday)
  return before > 0 ? Math.round(((sum(today) - before) / before) * 1000) / 10 : null
}

/** Sales per hour of day over the last 7 days. */
export function salesByHour(payments: MerchantPayment[]): number[] {
  const since = Date.now() - 7 * 86_400_000
  const hours = Array(24).fill(0) as number[]
  for (const p of payments) if (Date.parse(p.createdAt) >= since) hours[new Date(p.createdAt).getHours()] += p.amount
  return hours
}

export const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`

/** Saves the payments as a CSV file. */
export function exportPaymentsCsv(payments: MerchantPayment[], storeName: string) {
  const cell = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const rows = [
    ['Date', 'Time', 'Order', 'Customer', 'From address', 'Chain', 'Amount (USDC)', 'Status', 'Transaction'],
    ...payments.map(p => {
      const d = new Date(p.createdAt)
      return [d.toLocaleDateString('en-CA'), d.toLocaleTimeString('en-GB'), p.orderNumber, p.customerUsername ? `${p.customerUsername}.arc` : '',
        p.from, chainLabel(p.chain), p.amount.toFixed(2), p.status === 'collected' || p.chain === 'Arc_Testnet' ? 'On Arc' : 'On ' + chainLabel(p.chain), p.txHash]
    }),
  ]
  const blob = new Blob([rows.map(r => r.map(cell).join(',')).join('\n')], { type: 'text/csv' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${storeName.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'store'}-payments-${new Date().toLocaleDateString('en-CA')}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
