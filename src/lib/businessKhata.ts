// Business → Customers: each named customer's credit ledger (khata) - what
// the business billed them, what they paid, and what is still outstanding on
// bills they can still pay. Pure: built from the business's orders.

export type KhataOrder = {
  customerUsername: string | null
  amount: number
  received: number
  status: string
  expiresAt: string | null
  dueDate?: string | null
  /** Marked completed by the business (paid outside MeshPort, e.g. cash) */
  completedByMerchant?: boolean
}

export type Khata = {
  /** Billed on orders that still count (not cancelled, not expired unpaid) */
  billed: number
  /** Received on those orders */
  paid: number
  /** Still due on open and partly paid orders */
  outstanding: number
  /** Open / partly paid orders with something due */
  open: number
  /** Of those, past their due date */
  overdue: number
}

const OPEN = new Set(['pending', 'payment_detected', 'processing', 'partially_paid'])
const round = (n: number) => Math.round(n * 1e6) / 1e6
export const customerKey = (username: string) => `u:${username.replace(/\.arc$/i, '').toLowerCase()}`

const expired = (o: KhataOrder, now: number) => !!o.expiresAt && Date.parse(o.expiresAt) <= now
/** An order the customer can still pay. */
export const isOutstanding = (o: KhataOrder, now = Date.now()) =>
  OPEN.has(o.status) && !expired(o, now) && o.amount - o.received > 1e-6

/** Ledger for one list of orders (one customer's). */
export function khataOf(orders: KhataOrder[], now = Date.now(), today = new Date(now).toLocaleDateString('en-CA')): Khata {
  const k: Khata = { billed: 0, paid: 0, outstanding: 0, open: 0, overdue: 0 }
  for (const o of orders) {
    const dead = o.status === 'cancelled' || o.status === 'failed' || ((o.status === 'expired' || expired(o, now)) && o.status !== 'paid')
    // A cancelled or expired order counts only for what was paid on it.
    if (dead) { if (o.received > 0) { k.billed += o.received; k.paid += o.received } continue }
    k.billed += o.amount
    // Completed by the business: settled in full, whatever came in on-chain.
    k.paid += o.completedByMerchant && o.status === 'paid' ? o.amount : Math.min(o.received, o.amount)
    if (isOutstanding(o, now)) {
      k.outstanding += o.amount - o.received
      k.open++
      if (o.dueDate && o.dueDate < today) k.overdue++
    }
  }
  return { ...k, billed: round(k.billed), paid: round(k.paid), outstanding: round(k.outstanding) }
}

/** Ledgers for every named customer, keyed like Customers (`u:<username>`). */
export function khataByCustomer(orders: KhataOrder[], now = Date.now()): Map<string, Khata> {
  const groups = new Map<string, KhataOrder[]>()
  for (const o of orders) {
    if (!o.customerUsername) continue
    const key = customerKey(o.customerUsername)
    const g = groups.get(key) ?? []
    g.push(o); groups.set(key, g)
  }
  return new Map([...groups].map(([k, g]) => [k, khataOf(g, now)]))
}

/** Total still owed across all customers. */
export const totalOutstanding = (m: Map<string, Khata>) => round([...m.values()].reduce((s, k) => s + k.outstanding, 0))
