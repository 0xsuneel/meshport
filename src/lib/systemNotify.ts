// Mirrors a fresh in-app notification into the phone's notification shade.
//
// Many notifications are created only inside the app (an external deposit
// seen by the Arc watcher, rewards, swaps, claim arrivals…) and never had a
// system notification - on Android `new Notification()` doesn't work at all,
// it has to go through the service worker. The tag matches the one the
// server push for the same event uses, so the shade keeps ONE entry per
// event (the OS replaces same-tag notifications instead of stacking them).
import type { AppNotification } from '@/store'

const FRESH_MS = 3 * 60_000 // catch-up scans / seed fetches add old items - never re-alert those

function tagFor(n: Pick<AppNotification, 'id' | 'source'>): string {
  const id = n.id
  const m = /^ext_recv_tx_(0x[0-9a-f]+)$/i.exec(id)
  if (m) return `payment-${m[1].toLowerCase()}`          // api/chat.ts payment push
  if (id.startsWith('claim_')) return `claim-complete-${id.slice(6)}` // claim-worker push
  if (id.startsWith('bcast_')) return 'admin-broadcast'  // api/push.ts broadcast
  return `n-${id}`                                       // notifications table trigger push
}

/** Where tapping it goes - the thing it is about, not the notification list. */
export function urlFor(n: Pick<AppNotification, 'id' | 'tradeId' | 'type'>): string {
  const type = String(n.type)
  if (n.tradeId) return `/p2p/trade/${n.tradeId}`
  if (n.id.startsWith('claim_')) return '/multichain'
  if (type === 'merchant_payment_received') return '/business?tab=payments'
  if (type === 'merchant_chain_payment') return '/business?tab=settlements'
  if (type === 'merchant_approved' || type === 'business_staff_invite') return '/business'
  if (type === 'merchant_refund' || type === 'payment_received') return '/activity'
  if (type === 'reward_earned') return '/rewards'
  return '/notifications'
}

/**
 * Your own action, not something that happened to you: points for paying,
 * a swap you just made, "You paid … to <shop>", a refund you sent, your own
 * USDC arriving on another chain. Kept in the notification list, never put
 * in the phone's shade (the app already showed the result on screen).
 */
export function isOwnActionNotification(n: Pick<AppNotification, 'type' | 'title'>): boolean {
  const type = String(n.type)
  return type === 'reward_earned' || type === 'swap_complete'
    || type === 'merchant_order_paid' || type === 'merchant_refund_sent'
    || (type === 'merchant_chain_payment' && /^Your USDC arrived/i.test(n.title ?? ''))
}

export function mirrorToSystem(n: AppNotification): void {
  try {
    if (n.isRead || isOwnActionNotification(n)) return
    if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator)) return
    if (Notification.permission !== 'granted') return
    const t = Date.parse(n.timestamp)
    if (!Number.isFinite(t) || Date.now() - t > FRESH_MS) return
    navigator.serviceWorker.ready.then(reg => reg.showNotification(n.title, {
      body:  n.body,
      icon:  '/notification-icon.png',
      badge: '/notification-badge.png',
      tag:   tagFor(n),
      data:  { url: urlFor(n) },
    })).catch(() => {})
  } catch { /* never let a system-notification problem affect the app */ }
}
