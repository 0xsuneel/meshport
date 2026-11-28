// How bills and payment requests are named on screen. Pure (no network), so
// chat text helpers and tests can use it.
//
// Every order has an Order ID (28 Nov, like Paytm's): MP + date + 6 random
// letters/digits, e.g. MP261128K7Q2XA. It is a reference - shown labelled
// "Order ID" in details, receipts, PDFs and exports, never in a title
// ("Bill", "Payment Request", "Shop Payment"). Orders made before that
// carry ORD-100042, shown as #42. Links, card anchors, chat text and
// payment checks keep the stored value.
export function displayOrderNumber(n: string | null | undefined): string {
  return shortOrderNumber(n)
}

/** Who a bill / request is from: the business, and its store (branch) when
 *  that's a different name - "Royal Salons · Cutting Edge". */
export function shopFrom(name: string | null | undefined, store?: string | null): string {
  const n = (name ?? '').trim(), s = (store ?? '').trim()
  if (!s || s.toLowerCase() === n.toLowerCase()) return n
  return n ? `${n} · ${s}` : s
}

/** The Order ID people see: MP261128K7Q2XA as it is; an older ORD-100042 → #42. */
export function shortOrderNumber(n: string | null | undefined): string {
  const m = /^ORD-(\d+)$/i.exec(n || '')
  if (!m) return n || ''
  const k = Number(m[1]) - 100000
  return k > 0 ? `#${k}` : (n as string)
}

/** bill: a merchant's itemised bill · request: a normal user's payment
 *  request · merchant_request: a merchant's request from Receive · shop: a
 *  payment through a business's Shop QR (the customer typed the amount -
 *  nobody requested it). */
export type OrderKind = 'bill' | 'request' | 'merchant_request' | 'shop'
export function orderKindOf(v: { kind?: string | null; personal?: boolean | null; via?: string | null }): OrderKind {
  if (v.kind === 'invoice') return 'bill'
  if (v.via === 'shop_qr') return 'shop'
  return v.personal === false ? 'merchant_request' : 'request'
}
/**
 * Titles never carry the Order ID (28 Nov, like Paytm).
 * Waiting: "Bill" / "Payment Request" (a person's request or a business's
 * charge). Paid, payer's side: "Paid Bill" / "Request Paid" / "Payment
 * Request Paid". Paid, receiver's side (`received`): "Bill Received" /
 * "Request Received" / "Charge Received" ("Charge Payment Received" in full).
 * Shop QR: "Shop Payment" (both before and after paying) / "Received on
 * Royal Salons" - the business name the merchant registered (`business`,
 * else this device's own registered name; "Shop Payment Received" when
 * neither is known). `number` is accepted for older callers and ignored.
 */
export function orderTitle(kind: OrderKind, _number?: string | null, opts: { paid?: boolean; received?: boolean; short?: boolean; business?: string | null } = {}): string {
  if (opts.received) {
    if (kind === 'bill') return 'Bill Received'
    if (kind === 'shop') return shopReceivedTitle(opts.business)
    if (kind === 'merchant_request') return opts.short ? 'Charge Received' : 'Charge Payment Received'
    return 'Request Received'
  }
  if (kind === 'bill') return opts.paid ? 'Paid Bill' : 'Bill'
  if (kind === 'shop') return 'Shop Payment'
  if (kind === 'merchant_request') return opts.paid ? 'Payment Request Paid' : 'Payment Request'
  return opts.paid ? 'Request Paid' : 'Payment Request'
}

// The business name this device's merchant registered (lib/merchant.ts sets
// it once their application loads; kept on the device so it's there before
// that load on the next start). Only the merchant themselves receives Shop QR
// payments, so "received" titles can use it.
const BUSINESS_NAME_KEY = 'meshport_business_name_v1'
let registeredBusinessName: string | null = null
try { registeredBusinessName = globalThis.localStorage?.getItem(BUSINESS_NAME_KEY) || null } catch { /* no storage */ }
export function setRegisteredBusinessName(name: string | null | undefined): void {
  const n = (name ?? '').trim() || null
  if (n === registeredBusinessName) return
  registeredBusinessName = n
  try { if (n) globalThis.localStorage?.setItem(BUSINESS_NAME_KEY, n); else globalThis.localStorage?.removeItem(BUSINESS_NAME_KEY) } catch { /* no storage */ }
}
export function getRegisteredBusinessName(): string | null { return registeredBusinessName }
/** A Shop QR payment on the business's side: "Received on Royal Salons". */
export function shopReceivedTitle(business?: string | null): string {
  const n = (business ?? '').trim() || registeredBusinessName
  return n ? `Received on ${n}` : 'Shop Payment Received'
}

// A payment that settles an order ends with a tag naming it, e.g.
// "Sent 3 USDC to bob.arc · Bill #ORD-100042". Older payments say "Order"
// (or "Bill #ABC123" before order numbers existed). A Shop QR payment has no
// number: " · Payment" (older ones carried one: " · Payment #ORD-100108").
export const PAYMENT_ORDER_TAG = / · (?:(Bill|Request|Requested|Payment|Order) #([A-Z0-9-]{6,20})|(Payment))$/
export function paymentOrderTag(kind: OrderKind, number?: string | null): string {
  if (kind === 'shop') return number ? ` · Payment #${number}` : ' · Payment'
  return ` · ${kind === 'bill' ? 'Bill' : kind === 'merchant_request' ? 'Requested' : 'Request'} #${number}`
}
/** The order a payment message settles: its stored number ('' for Shop QR) and kind (null kind = older "Order" tag). */
export function parsePaymentOrderTag(text: string): { number: string; kind: OrderKind | null; index: number } | null {
  const m = PAYMENT_ORDER_TAG.exec(text)
  if (!m) return null
  const word = m[1] ?? m[3]
  const kind: OrderKind | null = word === 'Request' ? 'request' : word === 'Requested' ? 'merchant_request' : word === 'Bill' ? 'bill' : word === 'Payment' ? 'shop' : null
  return { number: m[2] ?? '', kind, index: m.index }
}
/** Title for a paid order from a payment tag ("Paid Bill"); `received`: the
 *  receiver's side ("Bill Received"). An older untyped tag reads "Paid" / "Received". */
export function paidTitleFromTag(t: { number: string; kind: OrderKind | null }, short = false, received = false): string {
  if (!t.kind) return received ? 'Received' : 'Paid'
  return orderTitle(t.kind, t.number, received ? { received: true, short } : { paid: true, short })
}

/** A payment request card that is a share of a Split Expense: the split's
 *  name from its note line ("Split · 🍕 Dinner" → "🍕 Dinner"), else null. */
export function splitNoteOf(text: string): string | null {
  const line = text.split('\n')[1]?.trim() ?? ''
  return line.startsWith('Split · ') ? line.slice('Split · '.length).trim() || null : null
}

/** A bill / request card's text → its one-line preview (chat list, reply
 *  quotes, search): "💸 Payment request · Order #ORD-100010 · $5.3 USDC…" →
 *  "💸 Payment Request · $5.3 USDC" (a Split Expense share: "🧾 Split
 *  Expense · 🍕 Dinner · $5 USDC"). null for any other text. */
export function orderCardPreview(text: string): string | null {
  const m = /^(🧾 Bill|💸 Payment request)(?: · Order #([A-Z0-9-]{3,20}))? · \$([\d.,]+) USDC/u.exec(text)
  if (!m) return null
  const split = m[1].startsWith('💸') ? splitNoteOf(text) : null
  if (split) return `🧾 Split Expense · ${split} · $${m[3]} USDC`
  const bill = m[1].startsWith('🧾')
  return `${bill ? '🧾 Bill' : '💸 Payment Request'} · $${m[3]} USDC`
}

/** The chat's pending strip: "1 pending bill" / "2 pending requests" /
 *  "1 bill · 1 request pending" (a mix was all called "bills"). */
export function pendingOrdersLabel(kinds: (string | null | undefined)[]): string {
  const bills = kinds.filter(k => k === 'invoice').length
  const reqs = kinds.length - bills
  const n = (c: number, w: string) => `${c} ${w}${c === 1 ? '' : 's'}`
  if (!reqs) return `${bills} pending bill${bills === 1 ? '' : 's'}`
  if (!bills) return `${reqs} pending request${reqs === 1 ? '' : 's'}`
  return `${n(bills, 'bill')} · ${n(reqs, 'request')} pending`
}
