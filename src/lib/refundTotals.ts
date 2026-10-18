// Business refunds: a payment can be refunded several times, as long as all
// its refunds together stay within the payment. Pure helpers for what was
// refunded, what is left, and what the business kept (used for netting in
// totals, statements, store totals and customers).

/** Smallest refund the app sends (same as merchant-refund). */
export const MIN_REFUND = 0.01

type RefundLike = { paymentId: string; amount: number; createdAt?: string }

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

/** Refunds grouped by payment, oldest first. */
export function groupRefunds<R extends RefundLike>(refunds: R[]): Map<string, R[]> {
  const m = new Map<string, R[]>()
  for (const r of refunds) m.set(r.paymentId, [...(m.get(r.paymentId) ?? []), r])
  for (const list of m.values()) list.sort((a, b) => Date.parse(a.createdAt ?? '') - Date.parse(b.createdAt ?? ''))
  return m
}

/** Sum of refunds (6 dp). */
export const refundedSum = (list: { amount: number }[] | undefined) => round6((list ?? []).reduce((s, r) => s + r.amount, 0))

/** What can still go back on a payment of `amount` after `refunded`. */
export const remainingAfter = (amount: number, refunded: number) => Math.max(0, round6(amount - refunded))

/** All of it went back. */
export const isFullyRefunded = (amount: number, refunded: number) => refunded > 0 && remainingAfter(amount, refunded) <= 1e-6

/** Another refund is possible (at least MIN_REFUND left). */
export const canRefundMore = (amount: number, refunded: number) => remainingAfter(amount, refunded) + 1e-9 >= MIN_REFUND

export type RefundState = { refunded: number; remaining: number; full: boolean; partial: boolean }
export function refundState(amount: number, refunded: number): RefundState {
  const full = isFullyRefunded(amount, refunded)
  return { refunded, remaining: remainingAfter(amount, refunded), full, partial: refunded > 1e-9 && !full }
}

/**
 * Payments with refunds taken off: each counts for what the business kept;
 * fully refunded ones are dropped.
 */
export function netPayments<P extends { id: string; amount: number }>(payments: P[], refundedOf: (id: string) => number): P[] {
  const out: P[] = []
  for (const p of payments) {
    const r = refundedOf(p.id)
    if (!r) { out.push(p); continue }
    const kept = remainingAfter(p.amount, r)
    if (kept > 1e-6) out.push({ ...p, amount: kept })
  }
  return out
}

/** Order refunds: the extra still to give back on an overpaid order. */
export const extraLeft = (overpaid: number, refundedOnOrder: number) => remainingAfter(overpaid, refundedOnOrder)

/**
 * The on-chain reference text for refund number `n` of a payment on the
 * MeshPortRefunds contract (one refund per reference): the payment id for the
 * first refund (so refunds made before multi-refunds stay valid), then
 * `${id}:${n}`. Same as merchant-refund.
 */
export const refundRefText = (paymentId: string, n: number) => n <= 1 ? paymentId : `${paymentId}:${n}`
