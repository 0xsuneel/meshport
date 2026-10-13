// moveFees.ts
// What a cross-chain move cost, for history cards and receipts: how much
// left, how much landed, and the fees in between.
//
// Bring (into Arc), CCTP: the person signed burned + MeshPort's fee
// (metadata.meshport_fee); Circle's fee comes out of the burn on mint.
// Bring, Unified Balance: claimed_amount is the deposit; Gateway's fee is
// the gap to what was minted on Arc.
// Transfer (out of Arc): amount is what was sent; arrived is what the
// receiver got after Circle's / Gateway's fee.
//
// Only answers once the arrived amount is known - never guesses one.

export interface MoveBreakdown {
  /** What left the source chain, fees included. */
  sent: number
  /** What landed (on Arc for a bring, at the receiver for a transfer). */
  received: number
  /** sent - received. */
  fees: number
  /** MeshPort's part of `fees` (gasless CCTP brings only). */
  meshportFee: number
  /** Circle's / Gateway's part of `fees`. */
  networkFee: number
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

/** Round to whole micro-USDC so float noise never shows up as a fee. */
const micro = (n: number) => Math.round(n * 1e6) / 1e6

export function moveBreakdown(kind: 'bring' | 'transfer', p: {
  amount: number
  arrivedAmount?: number | null
  /** Bring: the burned (CCTP) or deposited (Unified Balance) amount. */
  claimedAmount?: number | null
  meshportFee?: number | null
  status?: string
}): MoveBreakdown | null {
  if (p.status && p.status !== 'completed') return null
  const arrived = num(p.arrivedAmount)
  if (kind === 'transfer') {
    if (arrived == null || arrived <= 0) return null
    const sent = num(p.amount)
    if (sent == null || arrived > sent + 0.000001) return null
    const fees = micro(Math.max(0, sent - arrived))
    return { sent, received: arrived, fees, meshportFee: 0, networkFee: fees }
  }
  // Bring: a completed row's amount is what arrived (Activity rewrites it on completion).
  const received = arrived ?? num(p.amount)
  if (received == null || received <= 0) return null
  const burned = num(p.claimedAmount) ?? received
  const meshport = Math.max(0, num(p.meshportFee) ?? 0)
  if (received > burned + 0.000001) return null
  const network = micro(Math.max(0, burned - received))
  const sent = micro(burned + meshport)
  return { sent, received, fees: micro(network + meshport), meshportFee: micro(meshport), networkFee: network }
}

/** "$0.0254" - fees are small, so up to 4 decimals; never "$0.00" for a real fee. */
export function formatFee(n: number): string {
  if (n <= 0) return '$0'
  if (n < 0.0001) return '<$0.0001'
  const s = n < 0.01 ? n.toFixed(4) : n < 1 ? n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : n.toFixed(2)
  return `$${s}`
}

/** Sent / received figures: 4 decimals, so 9.99615 reads 9.9962 - never a rounded-up "10". */
export function formatMoveAmount(n: number): string {
  return n.toFixed(4).replace(/\.?0+$/, '')
}
