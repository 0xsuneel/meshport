// Business → numbers worked out from the store's own payments: day-over-day
// trend, sales by hour, and the CSV export. Runs on this device only.
import { displayOrderNumber, type MerchantPayment } from '@/lib/merchantPay'
import { chainLabel } from './settlement'
import { fetchFxHistory, rateAt, type FxPoint } from '@/lib/fxHistory'

const sameDay = (iso: string, d: Date) => new Date(iso).toDateString() === d.toDateString()

/** Today vs yesterday, in percent; null when yesterday had no sales. */
export function dayTrend(payments: MerchantPayment[]): number | null {
  const today = new Date(), yesterday = new Date(Date.now() - 86_400_000)
  const sum = (d: Date) => payments.filter(p => sameDay(p.createdAt, d)).reduce((s, p) => s + p.amount, 0)
  const before = sum(yesterday)
  return before > 0 ? Math.round(((sum(today) - before) / before) * 1000) / 10 : null
}

/** Sales per hour of day (the caller picks the period). */
export function salesByHour(payments: MerchantPayment[]): number[] {
  const hours = Array(24).fill(0) as number[]
  for (const p of payments) hours[new Date(p.createdAt).getHours()] += p.amount
  return hours
}

export const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`

/**
 * CSV rows: one per payment, with its rupee value at the USD→INR rate in
 * effect when it arrived (USDC counted as 1 USD), so an accountant can book
 * it in Tally / Zoho without converting by hand. "Rate date" is when that
 * rate was published; a payment older than the rate history gets the
 * earliest rate held, marked so. INR cells stay empty without any rates.
 */
export function paymentsCsvRows(payments: MerchantPayment[], refunds: { paymentId: string; amount: number }[] = [], inr: FxPoint[] = []): string[][] {
  // A payment can be refunded several times: the column is the total.
  const refunded = new Map<string, number>()
  for (const r of refunds) refunded.set(r.paymentId, (refunded.get(r.paymentId) ?? 0) + r.amount)
  const rows: (string | null)[][] = [
    ['Date', 'Time', 'Order', 'Customer', 'From address', 'Chain', 'Amount (USDC)', 'INR per USDC', 'Amount (INR)', 'Status',
      'Refunded (USDC)', 'Refunded (INR)', 'Rate date', 'Transaction'],
    ...payments.map(p => {
      const d = new Date(p.createdAt)
      const back = refunded.get(p.id)
      const rate = rateAt(inr, p.createdAt)
      return [d.toLocaleDateString('en-CA'), d.toLocaleTimeString('en-GB'), p.orderNumber ? displayOrderNumber(p.orderNumber) : null, p.customerUsername ? `${p.customerUsername}.arc` : '',
        p.from, chainLabel(p.chain), p.amount.toFixed(2),
        rate ? rate.usdRate.toFixed(4) : '', rate ? (p.amount * rate.usdRate).toFixed(2) : '',
        back != null ? (back >= p.amount - 1e-6 ? 'Refunded' : 'Partly refunded') : p.status === 'collected' || p.chain === 'Arc_Testnet' ? 'On Arc' : 'On ' + chainLabel(p.chain),
        back?.toFixed(2) ?? '', back != null && rate ? (back * rate.usdRate).toFixed(2) : '',
        rate ? `${new Date(rate.at).toLocaleDateString('en-CA')}${rate.before ? ' (earliest held)' : ''}` : '',
        p.txHash]
    }),
  ]
  return rows.map(r => r.map(v => v ?? ''))
}

/** Saves the payments as a CSV file (rates are read first; without them the INR columns are empty). */
export async function exportPaymentsCsv(payments: MerchantPayment[], storeName: string, refunds: { paymentId: string; amount: number }[] = []) {
  const times = payments.map(p => Date.parse(p.createdAt)).filter(Number.isFinite)
  const inr = times.length
    ? await fetchFxHistory('INR', new Date(Math.min(...times)).toISOString(), new Date(Math.max(...times)).toISOString()).catch(() => [])
    : []
  const cell = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  const rows = paymentsCsvRows(payments, refunds, inr)
  const blob = new Blob([rows.map(r => r.map(cell).join(',')).join('\n')], { type: 'text/csv' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${storeName.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'store'}-payments-${new Date().toLocaleDateString('en-CA')}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export type StatementRange = 'today' | 'week' | 'month'
export type StatementRow = { label: string; value: string; tone?: 'default' | 'success' | 'danger' | 'warning' }

/** Start of the range (local time). */
export function rangeStart(range: StatementRange): Date {
  const d = new Date(); d.setHours(0, 0, 0, 0)
  if (range === 'week') d.setDate(d.getDate() - 6)
  if (range === 'month') d.setDate(1)
  return d
}

export function rangeLabel(range: StatementRange): string {
  const fmt = (d: Date) => d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
  return range === 'today' ? fmt(new Date()) : `${fmt(rangeStart(range))} – ${fmt(new Date())}`
}

/** The day's (week's, month's) numbers: collected, refunds, net, settled, waiting. */
export function statementRows(p: {
  range: StatementRange; payments: MerchantPayment[]; refunds: { paymentId: string; amount: number; createdAt: string }[]
  settled: { amount: number; createdAt: string }[]; waiting: number
  /** Label for the customers row ("Guests", "Clients"…). */
  customersLabel?: string
}): StatementRow[] {
  const since = rangeStart(p.range).getTime()
  const inRange = (iso: string) => Date.parse(iso) >= since
  const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const pays = p.payments.filter(x => inRange(x.createdAt))
  const collected = pays.reduce((s, x) => s + x.amount, 0)
  const refunds = p.refunds.filter(r => inRange(r.createdAt))
  const refunded = refunds.reduce((s, r) => s + r.amount, 0)
  const settled = p.settled.filter(c => inRange(c.createdAt)).reduce((s, c) => s + c.amount, 0)
  const customers = new Set(pays.map(x => x.customerUsername || x.from.toLowerCase())).size
  return [
    { label: 'Collected', value: money(collected), tone: 'success' },
    { label: 'Payments', value: String(pays.length) },
    { label: p.customersLabel ?? 'Customers', value: String(customers) },
    { label: `Refunds (${refunds.length})`, value: refunded ? `−${money(refunded)}` : money(0), tone: refunded ? 'danger' : 'default' },
    { label: 'Net', value: money(collected - refunded) },
    { label: 'Settled to Arc', value: money(settled) },
    { label: 'Waiting on other chains', value: money(p.waiting), tone: p.waiting > 0 ? 'warning' : 'default' },
  ]
}
