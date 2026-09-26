/**
 * MeshPort Notification System
 * Rules:
 * - Fire: received payment, reward earned (send/multichain/bulk)
 * - Never fire: sent payment, tx hashes, explorer links
 * - Daily EARN cap 100pts (5 action types x 20, once each per day — see
 *   rewards.ts's own header comment for the full 2026-09-17 redesign) — no
 *   reward notif after cap. This is intentionally a different number from
 *   the on-chain CLAIM limit (200), which this file has nothing to do with.
 * - Badge 1–99 or "99+"
 */

import { useNotificationStore, useAuthStore } from '@/store'
import { supabase } from './supabase'
import { trimTrailingZeros } from './utils'
import { isMerchantNow } from './merchant'
import { hasRecentPaymentRequest } from './merchantPay'

// BUG FIX (2026-09-17): was 200, matching the OLD per-transaction earn cap.
// The earn side was redesigned to 5 action types x 20 = 100/day (see
// rewards.ts) — this must track that, not the separate on-chain claim
// limit, or a reward-earned notification could still fire even after the
// user has already hit today's actual earn cap.
const MAX_DAILY_PTS = 100

async function todayPoints(): Promise<number> {
  try {
    const { user, walletAddress } = useAuthStore.getState()
    // Try userId first, fallback to walletAddress lookup
    const userId = user?.id && !user.id.startsWith('usr_') ? user.id : null
    if (!userId && !walletAddress) return 0
    const today = new Date().toISOString().split('T')[0]
    const query = supabase.from('daily_tx_rewards').select('points').eq('reward_date', today)
    const { data } = userId
      ? await query.eq('user_id', userId).maybeSingle()
      : await query.ilike('user_id', `wallet_${(walletAddress || '').toLowerCase().slice(2, 18)}%`).maybeSingle()
    return data?.points || 0
  } catch { return 0 }
}

// ── Received payments (always fire — no cap) ──────────────────────────────────

// Amount text for notifications. Normal amounts keep 2 decimals; tiny
// amounts (e.g. 0.000003 USDC/EURC) show their real value instead of
// rounding to "0.0". Token precision: USDC/EURC 6 decimals, cirBTC 8.
export function formatNotifAmount(amount: number, tokenSymbol?: string): string {
  const symbol = (tokenSymbol || 'USDC').toUpperCase()
  const decimals = symbol === 'CIRBTC' ? 8 : 6
  const abs = Math.abs(amount)
  let num: string
  if (symbol === 'CIRBTC') num = trimTrailingZeros(abs.toFixed(8))
  else if (abs >= 0.01) num = trimTrailingZeros(abs.toFixed(2))
  else {
    const fixed = trimTrailingZeros(abs.toFixed(decimals))
    num = fixed === '0' || fixed === '' ? `<${(1 / 10 ** decimals).toFixed(decimals)}` : fixed
  }
  if (symbol === 'USDC') return num.startsWith('<') ? `<$${num.slice(1)}` : `$${num}`
  return `${num} ${tokenSymbol || symbol}`
}

// Merchants: a customer's order payment gets ONE notification — the server's
// "Payment received · order" (or "needs review") — not also the generic
// "Received from". At the moment the deposit lands the order may not be
// linked yet (the watcher runs every minute), so skip the generic one when
// the transfer is already linked to an order, or an open order is due this
// amount (exactly or within 10% — those become "Payment received" or
// "Payment needs review"). Every other deposit notifies as before.
async function isMerchantOrderPayment(id: string | undefined, amount: number, tokenSymbol?: string): Promise<boolean> {
  if ((tokenSymbol || 'USDC').toUpperCase() !== 'USDC' || !(amount > 0)) return false
  const tx = id?.startsWith('ext_recv_tx_') ? id.slice('ext_recv_tx_'.length).toLowerCase() : null
  if (tx && /^0x[0-9a-f]{64}$/.test(tx)) {
    const { data } = await supabase.from('merchant_payments').select('id').eq('tx_hash', tx).limit(1)
    if (data?.length) return true
  }
  const { data: open } = await supabase.from('merchant_payment_intents')
    .select('requested_amount, received_amount, expires_at')
    .in('status', ['pending', 'partially_paid'])
    .limit(200)
  return (open ?? []).some((i: any) => {
    if (i.expires_at && new Date(i.expires_at).getTime() < Date.now() - 5 * 60_000) return false
    const due = Number(i.requested_amount) - Number(i.received_amount)
    return due > 0 && Math.abs(due - amount) <= Math.max(0.1 * due, 0.01)
  })
}

function unlessMerchantOrder(id: string | undefined, amount: number, tokenSymbol: string | undefined, show: () => void) {
  // Everyone who isn't a merchant: notify immediately, exactly as before.
  // (Non-merchants who created a payment request recently get the order's
  // own "Payment received · Order #" instead of a second generic one.)
  if (!isMerchantNow() && !hasRecentPaymentRequest()) { show(); return }
  isMerchantOrderPayment(id, amount, tokenSymbol).then(skip => { if (!skip) show() }).catch(() => show())
}

export function notifyPaymentReceived({ amount, fromUsername, id, tokenSymbol, createdAt }: { amount: number; fromUsername: string; id?: string; tokenSymbol?: string; createdAt?: string }) {
  // BUG FIX: was .toFixed(6) for cirBTC, but cirBTC is an 8-decimal token
  // (same precision as real Bitcoin — see arcDepositWatcher.ts/arcService.ts/
  // swapService.ts, all of which correctly use decimals: 8). A genuine,
  // non-zero cirBTC amount using its 7th or 8th decimal place (e.g.
  // 0.00000001, a realistic amount per arcService.decimalAmount.test.ts's
  // own regression test) rounds to "0.000000" at 6 decimals, which
  // trimTrailingZeros then collapses down to "0.0" — the exact bug
  // reported: a real deposit showing as if it were zero.
  const amountStr = formatNotifAmount(amount, tokenSymbol)
  unlessMerchantOrder(id, amount, tokenSymbol, () => useNotificationStore.getState().addNotification({
    id,
    type: 'payment_received',
    title: 'Received from',
    body: `${amountStr} Received from ${fromUsername.replace(/\.arc$/, '')}.arc`,
    isRead: false,
    timestamp: createdAt,
  }))
}

export function notifyPaymentReceivedFromAddress({ amount, fromAddress, id, tokenSymbol, createdAt }: { amount: number; fromAddress: string; id?: string; tokenSymbol?: string; createdAt?: string }) {
  // Used only when the sender couldn't be resolved to a known MeshPort
  // username (see fireIfReceived in HomePage.tsx, which checks the
  // `users` table by wallet_address first and calls notifyPaymentReceived
  // instead when a username is found). This is the genuine fallback case —
  // a real external sender (exchange withdrawal, another wallet) where an
  // address really is the only identifying information available.
  const short = fromAddress.length > 12 ? fromAddress.slice(0, 6) + '...' + fromAddress.slice(-6) : fromAddress
  const symbol = (tokenSymbol || 'USDC').toUpperCase()
  // Same cirBTC 8-decimal fix as notifyPaymentReceived above.
  const amountStr = formatNotifAmount(amount, tokenSymbol || symbol)
  unlessMerchantOrder(id, amount, tokenSymbol || symbol, () => useNotificationStore.getState().addNotification({
    id,
    type: 'payment_received',
    title: 'Received from',
    body: `${amountStr} Received from ${short}`,
    isRead: false,
    timestamp: createdAt,
  }))
}

export function notifyMultichainPaymentReceived({ amount }: { amount: number }) {
  useNotificationStore.getState().addNotification({
    type: 'payment_received',
    title: 'Multichain Received',
    body: `You received a multichain payment of ${formatNotifAmount(amount)}.`,
    isRead: false,
  })
}

// A Unified Balance transfer that failed to reach its destination and got
// automatically recovered back to the Arc wallet (see lib/ubFundRecovery.ts)
// — always fires, no cap, same reasoning as the receive notifications above:
// this is money landing back in the user's own balance, not a routine event.
export function notifyUBFundsRecovered({ amount, id, createdAt }: { amount: number; id?: string; createdAt?: string }) {
  useNotificationStore.getState().addNotification({
    id,
    type: 'payment_received',
    title: 'Funds Recovered',
    body: `${formatNotifAmount(amount)} from an incomplete transfer was credited back to your Arc wallet.`,
    isRead: false,
    timestamp: createdAt,
  })
}

export function notifyBulkPaymentReceived({ amount, fromLabel, purpose, id, createdAt }: { amount: number; fromLabel: string; purpose?: string; id?: string; createdAt?: string }) {
  useNotificationStore.getState().addNotification({
    id,
    type: 'payment_received',
    title: 'Received from',
    body: purpose
      ? `You received ${formatNotifAmount(amount)} from ${fromLabel} — "${purpose}"`
      : `You received ${formatNotifAmount(amount)} from ${fromLabel} via bulk payout`,
    isRead: false,
    timestamp: createdAt,
  })
}

// ── Swap completed (always fire — no cap) ──────────────────────────────────

export function notifySwapComplete({ amountOut, tokenOut }: { amountOut: number; tokenOut: string }) {
  // Same cirBTC 8-decimal fix as notifyPaymentReceived above — this was
  // hardcoded to 2 decimals regardless of tokenOut, so a swap that output
  // a small cirBTC amount would show "0.00" here too.
  useNotificationStore.getState().addNotification({
    type: 'swap_complete',
    title: 'Swap Complete',
    body: `Received ${trimTrailingZeros(amountOut.toFixed(tokenOut.toUpperCase() === 'CIRBTC' ? 8 : 2))} ${tokenOut}`,
    isRead: false,
  })
}

// ── Reward claimed to USDC (always fire — no cap) ──────────────────────────

export function notifyRewardClaimed({ usdcAmount, points }: { usdcAmount: number; points: number }) {
  useNotificationStore.getState().addNotification({
    type: 'reward_earned',
    title: 'Reward Claimed',
    body: `+${trimTrailingZeros(usdcAmount.toFixed(2))} USDC for ${points} points`,
    isRead: false,
  })
}

// ── Reward notifications (check daily cap) ────────────────────────────────────

async function maybeRewardNotif(body: string) {
  try {
    const pts = await todayPoints()
    // pts is read AFTER the caller's awardTransactionPoints() has already
    // written this reward's own points to daily_tx_rewards, so it already
    // includes them. Checking `pts >= MAX_DAILY_PTS` meant the exact
    // transaction that reaches the cap (every 10th tx of the day, since
    // 20 pts x 10 tx = 200 = the cap) always fell right on the boundary
    // and got silently skipped — even though it genuinely earned points.
    // Only skip if the cap was already exceeded BEFORE this reward.
    if (pts > MAX_DAILY_PTS) return  // cap already exceeded — silent skip
  } catch { /* Supabase error — still fire the notif */ }
  useNotificationStore.getState().addNotification({
    type: 'reward_earned',
    title: 'Points Earned',
    body,
    isRead: false,
  })
}

export function notifyRewardSend(points = 20, tokenSymbol = 'USDC') {
  maybeRewardNotif(`You earned ${points} points for sending ${tokenSymbol}.`)
}

export function notifyRewardSwap(points = 20) {
  maybeRewardNotif(`You earned ${points} points for completing a swap.`)
}

export function notifyRewardMultichain(points = 20) {
  maybeRewardNotif(`You earned ${points} points for sending a multichain payment.`)
}

export function notifyRewardBulk(points = 20) {
  maybeRewardNotif(`You earned ${points} points for completing a bulk payment.`)
}

export function formatBadgeCount(count: number): string {
  if (count <= 0) return ''
  return count > 99 ? '99+' : String(count)
}
