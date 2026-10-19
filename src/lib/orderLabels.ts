// How bills and payment requests are named on screen. Pure (no network), so
// chat text helpers and tests can use it.
//
// Order numbers count from 100001 in the database; people see them as a
// short #N: ORD-100042 → #42. This is the one number people see everywhere
// (bills, requests, receipts, the Ledger, chat, exports). Display only -
// links, card anchors, the text stored in chat messages and payment
// verification keep the stored ORD-100042.
export function displayOrderNumber(n: string | null | undefined): string {
  // Kept as a named helper so call sites read clearly; same #N form as
  // shortOrderNumber (the number format is the same everywhere now).
  return shortOrderNumber(n)
}

/** The number people see for an order: ORD-100042 → #42. */
export function shortOrderNumber(n: string | null | undefined): string {
  const m = /^ORD-(\d+)$/i.exec(n || '')
  if (!m) return n || ''
  const k = Number(m[1]) - 100000
  return k > 0 ? `#${k}` : (n as string)
}

/** bill: a merchant's itemised bill · request: a normal user's payment
 *  request · merchant_request: a merchant's request from Receive. */
export type OrderKind = 'bill' | 'request' | 'merchant_request'
export function orderKindOf(v: { kind?: string | null; personal?: boolean | null }): OrderKind {
  if (v.kind === 'invoice') return 'bill'
  return v.personal === false ? 'merchant_request' : 'request'
}
/**
 * Waiting: "Bill ORD-00042" / "Request ORD-00043" / "Requested Payment ORD-00044".
 * Paid, payer's side: "Paid Bill ORD-00042" / "Request Amount Paid ORD-00043" /
 * "Requested Payment Paid ORD-00044".
 * Paid, receiver's side (`received`): "Bill ORD-00042 Received" /
 * "Request ORD-00043 Amount Received" / "Requested ORD-00044 Payment Received".
 * `short` (history rows, card bands): "#42" numbers - "Bill #42", "Requested #44",
 * "Request Paid · #43", "Request #43 Received".
 */
export function orderTitle(kind: OrderKind, number: string | null | undefined, opts: { paid?: boolean; received?: boolean; short?: boolean } = {}): string {
  const no = opts.short ? shortOrderNumber(number) : displayOrderNumber(number)
  if (opts.received) {
    if (kind === 'bill') return `Bill ${no} Received`
    if (kind === 'merchant_request') return opts.short ? `Requested ${no} Received` : `Requested ${no} Payment Received`
    return opts.short ? `Request ${no} Received` : `Request ${no} Amount Received`
  }
  const sep = opts.short ? ' · ' : ' '
  if (kind === 'bill') return opts.paid ? `Paid Bill ${no}` : `Bill ${no}`
  if (kind === 'merchant_request') return opts.paid ? `Requested Payment Paid${sep}${no}` : opts.short ? `Requested ${no}` : `Requested Payment ${no}`
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
/** `received`: the receiver's side ("Bill ORD-00042 Received"); older untyped tags read "ORD-00042 Received". */
export function paidTitleFromTag(t: { number: string; kind: OrderKind | null }, short = false, received = false): string {
  const no = short ? shortOrderNumber(t.number) : displayOrderNumber(t.number)
  if (!t.kind) return received ? `${no} Received` : `Paid ${no}`
  return orderTitle(t.kind, t.number, received ? { received: true, short } : { paid: true, short })
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
