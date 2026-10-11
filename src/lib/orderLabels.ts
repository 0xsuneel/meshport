// How bills and payment requests are named on screen. Pure (no network), so
// chat text helpers and tests can use it.
//
// Order numbers count from 100001 in the database; people see them from
// 00001: ORD-100042 → ORD-00042. Display only - links, card anchors, the
// text stored in chat messages and payment verification keep the stored one.
export function displayOrderNumber(n: string | null | undefined): string {
  const m = /^ORD-(\d+)$/i.exec(n || '')
  if (!m) return n || ''
  const k = Number(m[1]) - 100000
  return k > 0 ? `ORD-${String(k).padStart(5, '0')}` : (n as string)
}

/** bill: a merchant's itemised bill · request: a normal user's payment
 *  request · merchant_request: a merchant's request from Receive. */
export type OrderKind = 'bill' | 'request' | 'merchant_request'
export function orderKindOf(v: { kind?: string | null; personal?: boolean | null }): OrderKind {
  if (v.kind === 'invoice') return 'bill'
  return v.personal === false ? 'merchant_request' : 'request'
}
/**
 * "Bill ORD-00042" / "Request ORD-00043" / "Requested Payment ORD-00044";
 * paid: "Paid Bill ORD-00042" / "Request Amount Paid ORD-00043" /
 * "Requested Payment Paid ORD-00044". `short` (card bands): "Request Paid · ORD-00043".
 */
export function orderTitle(kind: OrderKind, number: string | null | undefined, opts: { paid?: boolean; short?: boolean } = {}): string {
  const no = displayOrderNumber(number)
  const sep = opts.short ? ' · ' : ' '
  if (kind === 'bill') return opts.paid ? `Paid Bill ${no}` : `Bill ${no}`
  if (kind === 'merchant_request') return opts.paid ? `Requested Payment Paid${sep}${no}` : `Requested Payment ${no}`
  return opts.paid ? (opts.short ? `Request Paid · ${no}` : `Request Amount Paid ${no}`) : `Request ${no}`
}

// A payment that settles an order ends with a tag naming it, e.g.
// "Sent 3 USDC to bob.arc · Bill #ORD-100042". Older payments say "Order"
// (or "Bill #ABC123" before order numbers existed).
export const PAYMENT_ORDER_TAG = / · (Bill|Request|Requested|Order) #([A-Z0-9-]{6,20})$/
export function paymentOrderTag(kind: OrderKind, number: string): string {
  return ` · ${kind === 'bill' ? 'Bill' : kind === 'merchant_request' ? 'Requested' : 'Request'} #${number}`
}
/** The order a payment message settles: its stored number and kind (null kind = older "Order" tag). */
export function parsePaymentOrderTag(text: string): { number: string; kind: OrderKind | null; index: number } | null {
  const m = PAYMENT_ORDER_TAG.exec(text)
  if (!m) return null
  const kind: OrderKind | null = m[1] === 'Request' ? 'request' : m[1] === 'Requested' ? 'merchant_request' : m[1] === 'Bill' ? 'bill' : null
  return { number: m[2], kind, index: m.index }
}
/** Title for a paid order from a payment tag; an older untyped tag reads "Paid ORD-00042". */
export function paidTitleFromTag(t: { number: string; kind: OrderKind | null }, short = false): string {
  return t.kind ? orderTitle(t.kind, t.number, { paid: true, short }) : `Paid ${displayOrderNumber(t.number)}`
}

/** A bill / request card's text → its one-line preview (chat list, reply
 *  quotes, search): "💸 Payment request · Order #ORD-100010 · $5.3 USDC…" →
 *  "💸 Request ORD-00010 · $5.3 USDC". null for any other text. */
export function orderCardPreview(text: string): string | null {
  const m = /^(🧾 Bill|💸 Payment request)(?: · Order #([A-Z0-9-]{3,20}))? · \$([\d.,]+) USDC/u.exec(text)
  if (!m) return null
  const bill = m[1].startsWith('🧾')
  const no = m[2] ? ' ' + displayOrderNumber(m[2]) : ''
  return `${bill ? '🧾 Bill' : '💸 Request'}${no} · $${m[3]} USDC`
}
