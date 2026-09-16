/**
 * MeshPort Notification System
 * Rules:
 * - Fire: received payment, reward earned (send/multichain/bulk)
 * - Never fire: sent payment, tx hashes, explorer links
 * - Daily reward cap 200pts — no reward notif after cap
 * - Badge 1–99 or "99+"
 */

import { useNotificationStore, useAuthStore } from '@/store'
import { supabase } from './supabase'
import { trimTrailingZeros } from './utils'

const MAX_DAILY_PTS = 200

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

export function notifyPaymentReceived({ amount, fromUsername, id, tokenSymbol, createdAt }: { amount: number; fromUsername: string; id?: string; tokenSymbol?: string; createdAt?: string }) {
  const amountStr = tokenSymbol && tokenSymbol.toUpperCase() !== 'USDC'
    ? `${trimTrailingZeros(amount.toFixed(tokenSymbol.toUpperCase() === 'CIRBTC' ? 6 : 2))} ${tokenSymbol}`
    : `$${trimTrailingZeros(amount.toFixed(2))}`
  useNotificationStore.getState().addNotification({
    id,
    type: 'payment_received',
    title: 'Received from',
    body: `${amountStr} Received from ${fromUsername.replace(/\.arc$/, '')}.arc`,
    isRead: false,
    timestamp: createdAt,
  })
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
  const amountStr = symbol === 'USDC' ? `$${trimTrailingZeros(amount.toFixed(2))}` : `${trimTrailingZeros(amount.toFixed(symbol === 'CIRBTC' ? 6 : 2))} ${tokenSymbol || 'USDC'}`
  useNotificationStore.getState().addNotification({
    id,
    type: 'payment_received',
    title: 'Received from',
    body: `${amountStr} Received from ${short}`,
    isRead: false,
    timestamp: createdAt,
  })
}

export function notifyMultichainPaymentReceived({ amount }: { amount: number }) {
  useNotificationStore.getState().addNotification({
    type: 'payment_received',
    title: 'Multichain Received',
    body: `You received a multichain payment of $${trimTrailingZeros(amount.toFixed(2))}.`,
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
    body: `$${trimTrailingZeros(amount.toFixed(2))} from an incomplete transfer was credited back to your Arc wallet.`,
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
      ? `You received $${trimTrailingZeros(amount.toFixed(2))} from ${fromLabel} — "${purpose}"`
      : `You received $${trimTrailingZeros(amount.toFixed(2))} from ${fromLabel} via bulk payout`,
    isRead: false,
    timestamp: createdAt,
  })
}

// ── Swap completed (always fire — no cap) ──────────────────────────────────

export function notifySwapComplete({ amountOut, tokenOut }: { amountOut: number; tokenOut: string }) {
  useNotificationStore.getState().addNotification({
    type: 'swap_complete',
    title: 'Swap Complete',
    body: `Received ${trimTrailingZeros(amountOut.toFixed(2))} ${tokenOut}`,
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
