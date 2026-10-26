// src/lib/merchantPayBasics.ts
//
// The parts of merchantPay that screens need before any payment happens -
// with no viem import, so they don't pull the wallet library into the app's
// first load (the Pay page and notifications load with it). merchantPay.ts
// re-exports all of this.

export type PayChain = { id: string; label: string; chainId: number; usdc: string; route: 'direct' | 'ub' }

export const ARC_PAY_CHAIN: PayChain = { id: 'Arc_Testnet', label: 'Arc', chainId: 5042002, usdc: '0x3600000000000000000000000000000000000000', route: 'direct' }

const PAYREQ_KEY = 'meshport-payreq-at'
export function markPaymentRequestCreated() {
  try { localStorage.setItem(PAYREQ_KEY, String(Date.now())) } catch { /* ignore */ }
}
export function hasRecentPaymentRequest(days = 8): boolean {
  try { return Date.now() - Number(localStorage.getItem(PAYREQ_KEY) || 0) < days * 864e5 } catch { return false }
}
