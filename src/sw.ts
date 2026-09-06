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
    badge: payload.badge || '/pwa-192x192.png',
    tag:   payload.tag,
    data:  payload.data || {},
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

// ── Tap a notification — focus an existing tab or open a new one ───────────
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close()
  const targetUrl = (event.notification.data && event.notification.data.url) || '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl)
          return client.focus()
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl)
      }
    }),
  )
})
