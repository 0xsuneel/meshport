// lib/p2pNotifications.ts
//
// Bridges the server-driven `notifications` table (populated by the
// p2p_notify_trade_event trigger — see
// supabase/migrations/20260730160000_p2p_notifications_system.sql) into
// the existing app-wide notification store (useNotificationStore) that
// already powers the bell/badge (PageHeader.tsx), the notification center
// (NotificationsPage in ProfileSubPages.tsx), and toasts (Toast.tsx).
//
// This is deliberately NOT a separate/parallel notification system — P2P
// events show up in the exact same bell, list, and toast as payment/reward
// notifications always have. The only thing new here is WHERE they come
// from: a real Supabase table + Realtime subscription instead of an
// in-memory call from p2pService.ts, so they arrive for the counterparty
// too (a different device/session), not just the browser tab that
// triggered the action.
//
// Usage: call `startP2PNotifications(userId)` once per session (see
// AppLayout.tsx) — it seeds the store with recent unread rows, subscribes
// to new ones in real time, and returns an unsubscribe function.

import { supabase } from './supabase'
import { authHeaders, subscribeWithRetry } from './chatService'
import { useNotificationStore, useUIStore, type AppNotification } from '../store'

const SUPA_URL = (import.meta.env.VITE_SUPABASE_URL as string) || ''

export type P2PNotificationType =
  | 'buy_order_placed' | 'sell_order_placed' | 'payment_marked_completed' | 'funds_released'
  | 'trade_cancelled' | 'trade_expired' | 'dispute_opened' | 'dispute_resolved' | 'refund_completed'

interface NotificationRow {
  id: string
  user_id: string
  type: string
  title: string
  message: string
  trade_id: string | null
  read: boolean
  created_at: string
}

function rowToAppNotification(r: NotificationRow): Omit<AppNotification, 'id' | 'timestamp'> & { id: string; timestamp: string } {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.message,
    isRead: r.read,
    timestamp: r.created_at,
    tradeId: r.trade_id ?? undefined,
  }
}

/**
 * Marks a P2P notification read BOTH locally (instant UI feedback, same as
 * every other notification type) AND on the server, so it stays read across
 * devices/reloads — unlike the purely-local notification types, this one's
 * source of truth is the `notifications` table itself.
 */
export async function markP2PNotificationRead(id: string): Promise<void> {
  useNotificationStore.getState().markRead(id)
  try {
    await fetch(`${SUPA_URL}/rest/v1/notifications?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ read: true }),
    })
  } catch { /* best-effort — local state already reflects read; next fetch will just re-sync */ }
}

/** Same idea as markP2PNotificationRead, but for "Mark all read" / bulk catch-up. */
async function markManyReadOnServer(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  try {
    await fetch(`${SUPA_URL}/rest/v1/notifications?id=in.(${ids.join(',')})`, {
      method: 'PATCH',
      headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ read: true }),
    })
  } catch { /* best-effort */ }
}

/**
 * Seeds the store with this user's recent notification rows (covers
 * anything that happened while they were offline/logged out — the whole
 * point of a server-backed feed) and opens a Realtime subscription for
 * anything new. addNotification()'s own id-based dedup (plus its permanent
 * seen-ids ledger) means calling this repeatedly, or a row arriving via
 * both the initial fetch AND a Realtime event, never double-shows anything.
 *
 * Returns an unsubscribe function — call on logout / userId change, same
 * contract as subscribeWithRetry's other call sites in this codebase.
 */
export function startP2PNotifications(userId: string): () => void {
  let cancelled = false

  ;(async () => {
    try {
      const res = await fetch(
        `${SUPA_URL}/rest/v1/notifications?user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=50`,
        { headers: await authHeaders() },
      )
      if (!res.ok || cancelled) return
      const rows: NotificationRow[] = await res.json()
      // Oldest first, so they land in the store in the same chronological
      // order addNotification's own prepend-to-front logic expects.
      for (const row of [...rows].reverse()) {
        useNotificationStore.getState().addNotification(rowToAppNotification(row))
      }
    } catch (e: any) {
      console.warn('[p2pNotifications] initial fetch failed:', e?.message)
    }
  })()

  const unsubscribe = subscribeWithRetry(supabase, `p2p-notifications-${userId}`, channel =>
    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
      (payload: any) => {
        const row = payload.new as NotificationRow
        useNotificationStore.getState().addNotification(rowToAppNotification(row))
        // Foreground toast — the OS-level push (dispatched server-side, see
        // the migration's push trigger) is what covers the app being
        // closed/backgrounded; this covers "app is open right now".
        useUIStore.getState().showToastMessage(`${row.title}: ${row.message}`, 'info')
      },
    ),
  )

  return () => { cancelled = true; unsubscribe() }
}

/** Bulk "mark all read" that also syncs the server-side rows for P2P types. */
export async function markAllP2PNotificationsReadOnServer(userId: string): Promise<void> {
  const ids = useNotificationStore.getState().notifications
    .filter(n => !n.isRead && P2P_TYPES.has(n.type as P2PNotificationType))
    .map(n => n.id)
  await markManyReadOnServer(ids)
  void userId // kept for symmetry with startP2PNotifications' signature; RLS already scopes the PATCH to this user's own rows
}

export const P2P_TYPES: Set<string> = new Set<P2PNotificationType>([
  'buy_order_placed', 'sell_order_placed', 'payment_marked_completed', 'funds_released',
  'trade_cancelled', 'trade_expired', 'dispute_opened', 'dispute_resolved', 'refund_completed',
])
