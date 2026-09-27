/**
 * Pulls admin broadcast announcements (sent from the Admin Control Panel's
 * Notifications page) into the user's in-app Notification list.
 *
 * This exists alongside — not instead of — OS-level Web Push. Web Push
 * requires the user to grant permission, have a device subscription saved,
 * and (on iOS) have installed the app to their Home Screen. Those are a lot
 * of things that can silently not be true. This sync guarantees every user
 * sees the announcement in-app the next time they open MeshPort, regardless
 * of push permission state.
 */

import { useNotificationStore } from '@/store'

interface BroadcastRow {
  id: string
  title: string
  body: string
  created_at: string
}

// v2 + per-wallet scoping: the old key ('meshport-broadcast-last-sync') was a
// single global value shared by every account on the device — unlike every
// other notification-related storage key in this app (notifKey/seenKey/
// walletKey in store/index.ts), which are all scoped per wallet address.
// Since this sync effect re-runs on account switch (see App.tsx), logging
// into a different wallet on the same device inherited whichever account
// was previously active's watermark, permanently skipping any broadcasts
// sent before that point for the new account (the server call itself is
// `since=gt.<timestamp>`, so they're never even fetched, let alone deduped
// by addNotification's normal per-address seen-ids ledger).
function lastSyncKey(addr: string | null) {
  return addr ? `meshport-broadcast-last-sync-v2-${addr.toLowerCase()}` : 'meshport-broadcast-last-sync-v2-anon'
}

export async function syncBroadcastNotifications(walletAddress: string | null): Promise<void> {
  try {
    const key = lastSyncKey(walletAddress)
    const since = localStorage.getItem(key) || ''
    const url = since
      ? `/api/push?action=feed&since=${encodeURIComponent(since)}`
      : `/api/push?action=feed`

    const r = await fetch(url)
    if (!r.ok) return
    const { data } = await r.json().catch(() => ({ data: [] as BroadcastRow[] }))
    if (!Array.isArray(data) || data.length === 0) return

    // API returns newest-first; add oldest-first so the list ends up
    // newest-first after each unshift in addNotification.
    const ordered = [...data].reverse()
    for (const b of ordered as BroadcastRow[]) {
      useNotificationStore.getState().addNotification({
        id: `bcast_${b.id}`,
        type: 'admin_broadcast',
        title: b.title,
        body: b.body,
        isRead: false,
        timestamp: b.created_at,
      })
    }

    // Newest broadcast's created_at becomes the new "since" watermark
    const newest = data[0]?.created_at
    if (newest) localStorage.setItem(key, newest)
  } catch (e: any) {
    console.warn('[broadcastSync] failed:', e?.message)
  }
}
