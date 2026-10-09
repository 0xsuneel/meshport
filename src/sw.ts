/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'
import { CacheFirst, StaleWhileRevalidate } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { CacheableResponsePlugin } from 'workbox-cacheable-response'

declare let self: ServiceWorkerGlobalScope

// ── Precache (same role generateSW used to handle automatically) ────────────
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// ── Works on a weak or missing connection ──────────────────────────────────
// Opening the app (or any page of it: /multichain, /activity…) is answered
// from the installed copy at once, so a slow network never shows a blank
// screen or the browser's offline page; only the data loads over the network.
// A new deploy still arrives as before (the service worker updates itself).
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), {
  // Server routes (incl. the pay links' preview pages, served by /api/og-pay)
  // and files that aren't app pages always go to the network.
  denylist: [/^\/api\//, /^\/pay(link)?\//, /^\/auth\/v1\//, /\/[^/?]+\.[a-z0-9]+$/i],
}))

// Inter font: the stylesheet refreshes in the background, font files are
// kept (they never change at a given URL).
registerRoute(({ url }) => url.origin === 'https://fonts.googleapis.com',
  new StaleWhileRevalidate({ cacheName: 'mp-font-css' }))
registerRoute(({ url }) => url.origin === 'https://fonts.gstatic.com',
  new CacheFirst({
    cacheName: 'mp-font-files',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 365 * 24 * 3600 }),
    ],
  }))

// Pictures (profile photos, token and chain logos from other sites): shown
// from the device once seen, refreshed in the background.
registerRoute(({ request, url }) => request.destination === 'image' && url.origin !== self.location.origin,
  new StaleWhileRevalidate({
    cacheName: 'mp-images',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 30 * 24 * 3600, purgeOnQuotaError: true }),
    ],
  }))

// A new version waits instead of taking over the open app: switching
// mid-use removed the files the open screens still needed (the next screen
// failed to load and the app reloaded itself - slow, looked frozen). The app
// tells it to take over when that's safe: at the next app open, behind the
// opening screen, or when coming back after a long time away (lib/swUpdate.ts).
// A first install (nothing to replace) still activates straight away.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
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
    icon:  payload.icon  || '/notification-icon.png',
    // Android draws the badge (status bar + header icon) from its alpha only,
    // so it must be a white mark on transparent - not the solid app icon.
    badge: payload.badge || '/notification-badge.png',
    tag:   payload.tag,
    data:  payload.data || {},
  }

  // Always shown in the phone's notification shade. Duplicates are avoided
  // by tag: the app mirrors its own in-app notification with the same tag
  // (lib/systemNotify.ts), so the OS keeps a single entry per event.
  event.waitUntil(self.registration.showNotification(title, options))
})

// ── Tap a notification - focus an existing tab or open a new one ───────────
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close()
  // Only pages of this app - a notification can never open another site.
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
          // navigate() rejects for a window this SW doesn't control yet -
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
