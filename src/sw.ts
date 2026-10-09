/// <reference lib="webworker" />
import { precache, addRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'
import { CacheFirst, StaleWhileRevalidate } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { CacheableResponsePlugin } from 'workbox-cacheable-response'

declare let self: ServiceWorkerGlobalScope

// ── Precache (same role generateSW used to handle automatically) ────────────
// The files are stored now; their route is added AFTER the page route below.
// (precacheAndRoute() registered it first, and it answers "/" from the stored
// index.html - so opening the app always ran the stored old version.)
precache(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// ── Pages: the live version first, the installed copy when offline/slow ────
// Like other web apps (X, Gmail, Slack…): opening the app asks the server for
// the current page, so a new deploy shows on the very next open or refresh -
// it no longer waits for this service worker to download the whole new
// offline copy (~5 MB) in the background. If the network doesn't answer within
// 2s (weak connection) or there's none, the installed copy opens instead, so
// a slow network still never shows a blank screen or the browser's offline
// page. A switch to a new version (lib/swUpdate.ts) adds ?_v=… and waits
// longer for the network, since the point is to get the new page.
const appShell = createHandlerBoundToURL('/index.html')
const NAV_TIMEOUT_MS = 2000
const NAV_TIMEOUT_UPDATE_MS = 15000
registerRoute(new NavigationRoute(async (options) => {
  const { url } = options
  const wait = url.searchParams.has('_v') ? NAV_TIMEOUT_UPDATE_MS : NAV_TIMEOUT_MS
  try {
    // By URL, not the browser's navigation request: always the live page
    // (no HTTP cache) and server redirects are followed.
    const res = await Promise.race([
      fetch(url.href, { credentials: 'same-origin', cache: 'no-store', redirect: 'follow' }),
      new Promise<null>(resolve => setTimeout(() => resolve(null), wait)),
    ])
    if (res && res.ok) {
      // A followed redirect can't answer a page load as-is (browsers reject it).
      return res.redirected ? new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers }) : res
    }
  } catch { /* offline - use the installed copy */ }
  return appShell(options)
}, {
  // Server routes (incl. the pay links' preview pages, served by /api/og-pay)
  // and files that aren't app pages always go to the network.
  denylist: [/^\/api\//, /^\/pay(link)?\//, /^\/auth\/v1\//, /\/[^/?]+\.(?!html$)[a-z0-9]+$/i],
}))

// Stored files (scripts, styles, icons) - after the page route, see above.
addRoute()

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

// A new offline copy waits instead of taking over the open app: switching
// mid-use removed the files the open screens still needed. The app tells it to
// take over once the page itself is on the new version (lib/swUpdate.ts) -
// then there is nothing left that needs the old files. A first install
// (nothing to replace) still activates straight away.
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
