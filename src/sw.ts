/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'

declare let self: ServiceWorkerGlobalScope

// ── Precache (same role generateSW used to handle automatically) ────────────
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// ── Web Push ──────────────────────────────────────────────────────────────
self.addEventListener('push', (event: PushEvent) => {
  if (!event.data) return

  let payload: { title?: string; body?: string; icon?: string; badge?: string; tag?: string; data?: any }
  try {
    payload = event.data.json()
  } catch {
    payload = { title: 'MeshPort', body: event.data.text() }
  }

  const title = payload.title || 'MeshPort'
  const options: NotificationOptions = {
    body:  payload.body || '',
    icon:  payload.icon  || '/pwa-192x192.png',
    // Android draws the badge (status bar + header icon) from its alpha only,
    // so it must be a white mark on transparent — not the solid app icon.
    badge: payload.badge || '/notification-badge.png',
    tag:   payload.tag,
    data:  payload.data || {},
  }

  // Always shown in the phone's notification shade. Duplicates are avoided
  // by tag: the app mirrors its own in-app notification with the same tag
  // (lib/systemNotify.ts), so the OS keeps a single entry per event.
  event.waitUntil(self.registration.showNotification(title, options))
})

// ── Tap a notification — focus an existing tab or open a new one ───────────
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close()
  // Only pages of this app — a notification can never open another site.
  const targetUrl = (() => {
    try {
      const u = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin)
      return u.origin === self.location.origin ? u.href : '/'
    } catch { return '/' }
  })()

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clientList) => {
      // Prefer the window the user is looking at, then any open one.
      const windows = clientList as WindowClient[]
      const client = windows.find(c => c.focused) ?? windows[0]
      if (client) {
        const focused = await client.focus()
        try {
          await (focused ?? client).navigate(targetUrl)
        } catch {
          // navigate() rejects for a window this SW doesn't control yet —
          // open the target instead of silently doing nothing.
          if (self.clients.openWindow) await self.clients.openWindow(targetUrl)
        }
        return
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl)
      }
    }),
  )
})
