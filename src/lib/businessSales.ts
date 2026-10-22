// lib/businessSales.ts
//
// What a business was paid, for Insights outside the Business tab (desktop
// Home's Business Insights). The same list Business shows: order payments
// (requests, bills, Shop QR - on Arc or another chain) plus every USDC
// receipt on another chain with no matching order, refunds taken off, and
// the owner's own transfers between chains left out (never a sale).

import { listMyPayments, listChainReceipts, listMyIntents, isOwnReceipt, type MerchantPayment, type ChainReceipt, type MerchantIntent } from './merchantPay'
import type { Store } from './businessTeam'
import { listMyRefunds } from './merchantRefunds'
import { groupRefunds, refundedSum, netPayments } from './refundTotals'

/** Order payments + other-chain receipts with no matching order, newest first. */
export function mergeSales(orders: MerchantPayment[], receipts: ChainReceipt[], walletAddress: string | null | undefined): MerchantPayment[] {
  const known = new Set(orders.map(p => `${p.chain}:${p.txHash.toLowerCase()}`))
  const extra: MerchantPayment[] = receipts
    .filter(r => !known.has(`${r.chain}:${r.txHash.toLowerCase()}`))
    .map(r => ({ id: `rcpt_${r.id}`, intentId: '', chain: r.chain, txHash: r.txHash, from: r.from ?? '0x0000000000000000000000000000000000000000',
      amount: r.amount, method: isOwnReceipt(r, walletAddress) ? 'own_transfer' : r.orderNumber ? 'chain_receipt' : 'direct',
      status: r.status === 'converted' ? 'collected' : 'in_ledger', customerUsername: null,
      createdAt: r.createdAt, orderNumber: r.orderNumber, matchedBy: null, screenFlag: r.screenFlag ?? null }))
  return [...orders, ...extra].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

/** The business's sales: refunds taken off, fully refunded and own transfers left out. */
export async function loadBusinessSales(walletAddress: string | null | undefined): Promise<MerchantPayment[]> {
  const [orders, receipts, refunds] = await Promise.all([
    listMyPayments(500),
    listChainReceipts(300).catch(() => [] as ChainReceipt[]),
    listMyRefunds().catch(() => []),
  ])
  const byPayment = groupRefunds(refunds)
  return netPayments(mergeSales(orders, receipts, walletAddress).filter(p => p.method !== 'own_transfer'), id => refundedSum(byPayment.get(id)))
}

/**
 * Which store each sale belongs to, as the Business tab decides it: its
 * order's store; a receipt carries the order number instead; anything with
 * neither (taken before stores, plain transfers) is the main store's.
 */
export function storeOfSale(intents: MerchantIntent[], stores: Store[]): (p: MerchantPayment) => string | null {
  const byIntent = new Map(intents.map(i => [i.id, i.storeId ?? null] as const))
  const byOrder = new Map(intents.filter(i => i.orderNumber).map(i => [i.orderNumber!, i.storeId ?? null] as const))
  const main = stores.find(s => s.isDefault)?.id ?? stores[0]?.id ?? null
  return p => (p.intentId ? byIntent.get(p.intentId) : p.orderNumber ? byOrder.get(p.orderNumber) : null) ?? main
}

/** Sales plus the stores and each sale's store - the full report's data. */
export async function loadBusinessReport(walletAddress: string | null | undefined): Promise<{ sales: MerchantPayment[]; stores: Store[]; storeOf: (p: MerchantPayment) => string | null }> {
  const { listStores } = await import('./businessTeam')
  const [sales, intents, stores] = await Promise.all([
    loadBusinessSales(walletAddress),
    listMyIntents(500).catch(() => [] as MerchantIntent[]),
    listStores().catch(() => [] as Store[]),
  ])
  return { sales, stores, storeOf: storeOfSale(intents, stores) }
}

/** Who paid, as the Business tab names them. */
export const salesCustomer = (p: MerchantPayment) => p.customerUsername ? `${p.customerUsername}.arc`
  : /^0x0{40}$/i.test(p.from) ? 'Bridge payment' : `${p.from.slice(0, 6)}…${p.from.slice(-4)}`

export interface SalesSummary {
  total: number
  count: number
  customers: number
  average: number
  largest: number
  /** Change vs the window before, in percent; null when that window had nothing. */
  totalChange: number | null
  countChange: number | null
  customersChange: number | null
  /** Busiest hour of day (0-23), null with no sales. */
  peakHour: number | null
  /** Sales per hour of day (0-23). */
  hours: number[]
  topCustomers: { name: string; total: number; count: number }[]
  chains: { chain: string; total: number; share: number }[]
}

const change = (now: number, before: number) => before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null

/** Sales in [from, to), compared with the window of the same length before it. */
export function summarizeSales(sales: MerchantPayment[], from: number, to: number): SalesSummary {
  const len = to - from
  const within = (a: number, b: number) => sales.filter(p => { const t = Date.parse(p.createdAt); return t >= a && t < b })
  const list = within(from, to), prev = within(from - len, from)
  const sum = (l: MerchantPayment[]) => l.reduce((s, p) => s + p.amount, 0)
  const buyers = (l: MerchantPayment[]) => new Set(l.map(salesCustomer)).size
  const total = sum(list)
  const hours = new Array(24).fill(0) as number[]
  for (const p of list) hours[new Date(p.createdAt).getHours()] += p.amount
  const peak = hours.indexOf(Math.max(...hours))
  const group = (key: (p: MerchantPayment) => string) => {
    const m = new Map<string, { total: number; count: number }>()
    for (const p of list) { const k = key(p); const v = m.get(k) ?? { total: 0, count: 0 }; v.total += p.amount; v.count++; m.set(k, v) }
    return [...m.entries()].sort((a, b) => b[1].total - a[1].total)
  }
  return {
    total, count: list.length, customers: buyers(list),
    average: list.length ? total / list.length : 0,
    largest: list.reduce((m, p) => Math.max(m, p.amount), 0),
    totalChange: change(total, sum(prev)),
    countChange: change(list.length, prev.length),
    customersChange: change(buyers(list), buyers(prev)),
    peakHour: total > 0 ? peak : null,
    hours,
    topCustomers: group(salesCustomer).slice(0, 5).map(([name, v]) => ({ name, ...v })),
    chains: group(p => p.chain).map(([chain, v]) => ({ chain, total: v.total, share: total ? v.total / total : 0 })),
  }
}

/** Sales per bucket across [from, to): `count` buckets of equal length. */
export function salesSeries(sales: MerchantPayment[], from: number, to: number, count: number): number[] {
  const out = new Array(count).fill(0) as number[]
  const step = (to - from) / count
  for (const p of sales) {
    const t = Date.parse(p.createdAt)
    if (t < from || t >= to) continue
    out[Math.min(count - 1, Math.floor((t - from) / step))] += p.amount
  }
  return out
}
