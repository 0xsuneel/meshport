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

function urlFor(n: Pick<AppNotification, 'id' | 'tradeId' | 'type'>): string {
  if (n.tradeId) return `/p2p/trade/${n.tradeId}`
  if (n.id.startsWith('claim_')) return '/multichain'
  if (String(n.type).startsWith('merchant_')) return '/merchant'
  return '/notifications'
}

export function mirrorToSystem(n: AppNotification): void {
  try {
    if (n.isRead) return
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
