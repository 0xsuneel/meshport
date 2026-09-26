import { lazy, type ComponentType } from 'react'

// ── lazyRetry — resilient wrapper around React.lazy ─────────────────────────
//
// Every route is lazy-loaded from a content-hashed chunk (e.g.
// "HomePage-C0ytuU54.js"). After a new deploy the old chunk files are gone.
// A tab (or installed PWA) still running the OLD index.html then asks for a
// chunk that no longer exists and import() throws "Failed to fetch
// dynamically imported module".
//
// A plain reload was not always enough: the service worker precaches
// index.html, so the reload could be served the SAME old index.html from the
// SW cache, fail again, and land on the error screen. recoverFromStaleBuild()
// therefore clears the SW caches (and on a second attempt unregisters the SW)
// before reloading, so the reload is guaranteed to fetch the current build
// from the network.

const RELOAD_KEY = 'meshport_stale_build_reload'
const RETRY_COOLDOWN_MS = 30_000

export function isChunkLoadError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? '')
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Expected a JavaScript-or-Wasm module script|ChunkLoadError|Loading chunk .* failed/i.test(msg)
}

async function clearSwCaches(unregister: boolean): Promise<void> {
  try {
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map(k => caches.delete(k)))
    }
  } catch { /* ignore */ }
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map(r => (unregister ? r.unregister() : r.update()).catch(() => undefined)))
    }
  } catch { /* ignore */ }
}

/**
 * Reloads onto the current build. Returns false if we already tried twice in
 * the last 30s (genuinely offline / broken deploy) so callers can show an error
 * instead of reload-looping.
 */
export async function recoverFromStaleBuild(force = false): Promise<boolean> {
  let state = { at: 0, n: 0 }
  try { state = JSON.parse(sessionStorage.getItem(RELOAD_KEY) || '{"at":0,"n":0}') } catch { /* ignore */ }
  const recent = Date.now() - state.at < RETRY_COOLDOWN_MS
  const attempt = recent ? state.n + 1 : 1
  if (!force && attempt > 2) return false
  try { sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ at: Date.now(), n: attempt })) } catch { /* ignore */ }
  // 1st try: drop cached files. 2nd try (or manual): also remove the SW.
  await clearSwCaches(force || attempt >= 2)
  const url = new URL(window.location.href)
  url.searchParams.set('_v', String(Date.now()))
  window.location.replace(url.toString())
  return true
}

/** Call once the app has rendered fine, so a later deploy gets fresh retries. */
export function markBuildHealthy() {
  try { sessionStorage.removeItem(RELOAD_KEY) } catch { /* ignore */ }
  // Tidy the cache-buster param added by recoverFromStaleBuild.
  try {
    const url = new URL(window.location.href)
    if (url.searchParams.has('_v')) {
      url.searchParams.delete('_v')
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    }
  } catch { /* ignore */ }
}

export function lazyRetry<T extends ComponentType<any>>(
  importFn: () => Promise<{ default: T }>,
  _chunkName: string,
) {
  return lazy(async () => {
    try {
      return await importFn()
    } catch (err) {
      if (isChunkLoadError(err) && await recoverFromStaleBuild()) {
        // Never resolves — the reload replaces this page.
        return new Promise<{ default: T }>(() => {})
      }
      throw err
    }
  })
}
