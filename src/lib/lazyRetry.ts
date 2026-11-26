import { lazy, type ComponentType } from 'react'
import { isOnline, onReconnect } from './connectivity'

// ── lazyRetry - resilient wrapper around React.lazy ─────────────────────────
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
const MY_BUILD: string = typeof __MP_BUILD__ === 'string' ? __MP_BUILD__ : ''

/**
 * Is a newer version live? A file that failed to load is the same error
 * whether the deploy removed it or a weak connection dropped it - only the
 * server's /version.json tells them apart. 'unknown' when it can't be asked.
 */
export async function buildVerdict(timeoutMs = 8000): Promise<'stale' | 'current' | 'unknown'> {
  if (!MY_BUILD) return 'unknown'
  try {
    const res = await fetch('/version.json', { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return 'unknown'
    const j = await res.json()
    if (typeof j?.build !== 'string' || !j.build) return 'unknown'
    return j.build === MY_BUILD ? 'current' : 'stale'
  } catch { return 'unknown' }
}

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
  // A reload that moved onto a new version starts that version's count afresh.
  const recent = Date.now() - state.at < RETRY_COOLDOWN_MS && (state as { b?: string }).b === MY_BUILD
  const attempt = recent ? state.n + 1 : 1
  if (!force && attempt > 2) return false
  try { sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ at: Date.now(), n: attempt, b: MY_BUILD })) } catch { /* ignore */ }
  // Only a real update drops the offline copy. When this version is still the
  // live one (or the server can't be asked), the file failed to download on a
  // weak connection: dropping the copy made every reload download the whole
  // app again over that same connection, fail again and land on "MeshPort
  // was updated" - forever. A plain reload keeps the copy, which loads fast.
  // 1st try: drop cached files. 2nd try (or manual): also remove the SW.
  const verdict = await buildVerdict()
  if (verdict === 'stale') await clearSwCaches(force || attempt >= 2)
  // Same version, failed again: a stored screen file is bad. Those files are
  // re-downloaded as screens open; the offline core is kept.
  else if (force || attempt >= 2) await dropStoredScreens()
  const url = new URL(window.location.href)
  url.searchParams.set('_v', String(Date.now()))
  window.location.replace(url.toString())
  return true
}

/**
 * Listener for Vite's `vite:preloadError`. It must NOT call preventDefault():
 * when that event is cancelled, Vite resolves the failed import() with
 * `undefined` instead of throwing (vite 5 preload helper:
 * `baseModule().catch(handlePreloadError)`), so a route's
 * `.then(m => ({ default: m.HomePage }))` threw "Cannot read properties of
 * undefined (reading 'HomePage')" - not recognised as a stale build, so the
 * user got "Something went wrong" instead of the update reload. Left alone,
 * the import throws "Failed to fetch dynamically imported module", which
 * lazyRetry (and the unhandledrejection handler) turn into a reload onto the
 * current build.
 */
export function onVitePreloadError(e: Event): void {
  console.warn('[stale build] a file of an older version failed to load', (e as Event & { payload?: unknown }).payload)
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

/** Where the device is right now, for a [chunk] report. */
function chunkContext(): string {
  const nav = navigator as Navigator & { connection?: { effectiveType?: string; downlink?: number } }
  const sw = typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? !!navigator.serviceWorker.controller : false
  return `online=${nav.onLine !== false} net=${nav.connection?.effectiveType ?? '?'}/${nav.connection?.downlink ?? '?'}Mbps sw=${sw} build=${MY_BUILD || '?'}`
}

/**
 * "Failed to fetch dynamically imported module: X.js" names the screen's own
 * file even when one of the files IT imports is the one that failed. Reports
 * showed X.js itself downloading fine in ~20 ms, the server on the same
 * version, and the screen still failing on every reload: a file it imports was
 * stuck bad in the device's copy (the app's file cache keeps a file once it
 * has it). This walks X.js and the files it imports (through the same cache),
 * drops any that doesn't come back as a script from every cache, and fetches it
 * again from the server, so the next load gets a good copy. Returns what it found.
 */
async function repairImports(err: unknown): Promise<string> {
  const top = /(https?:\/\/[^\s'"]+\.js)/.exec(String((err as any)?.message ?? ''))?.[1]
  if (!top || new URL(top).origin !== window.location.origin) return ''
  const seen = new Set<string>([top])
  const queue = [top]
  const bad: string[] = []
  const deadline = performance.now() + 6_000
  while (queue.length && performance.now() < deadline && seen.size < 120) {
    const batch = queue.splice(0, 8)
    await Promise.all(batch.map(async url => {
      let problem = ''
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
        const type = res.headers.get('content-type') || ''
        if (!res.ok) problem = String(res.status)
        else if (!/javascript|ecmascript/i.test(type)) problem = type.split(';')[0] || 'no type'
        else {
          const text = await res.text()
          if (!text.length) problem = 'empty'
          else for (const m of text.matchAll(/(?:from|import)\s*["'](\.\/[^"']+\.js)["']/g)) {
            const dep = new URL(m[1], url).href
            if (!seen.has(dep)) { seen.add(dep); queue.push(dep) }
          }
        }
      } catch (e) { problem = (e as Error)?.name === 'TimeoutError' ? 'timeout' : 'network' }
      if (problem) bad.push(`${url.split('/').pop()} (${problem})`)
      if (problem && problem !== 'timeout' && problem !== 'network') await evictEverywhere(url)
    }))
  }
  return bad.length ? `bad: ${bad.slice(0, 5).join(', ')}` : `${seen.size} files ok`
}

/** Drops a file from every cache, then fetches a fresh copy from the server. */
async function evictEverywhere(url: string): Promise<void> {
  try {
    if ('caches' in window) for (const k of await caches.keys()) {
      const c = await caches.open(k)
      for (const r of await c.keys()) if (r.url.split('?')[0] === url) await c.delete(r)
    }
  } catch { /* ignore */ }
  try { await (await fetch(url, { cache: 'reload', signal: AbortSignal.timeout(15_000) })).arrayBuffer() } catch { /* ignore */ }
}

/** The screen files the app stored as they were opened (not the offline core). */
async function dropStoredScreens(): Promise<void> {
  try { if ('caches' in window) await caches.delete('mp-assets') } catch { /* ignore */ }
}

/**
 * The file a failed import named, fetched again (a few tries) so the reload
 * that follows finds it in the browser's cache - on a weak connection the
 * reload otherwise asks for the same large file over the same link and fails
 * the same way (two reloads, then "This screen didn't load"). Returns how it went.
 */
async function warmFailedFile(err: unknown): Promise<string> {
  const url = /(https?:\/\/[^\s'"]+\.(?:js|css))/.exec(String((err as any)?.message ?? ''))?.[1]
  if (!url || new URL(url).origin !== window.location.origin) return 'no file url'
  for (let i = 0; i < 3; i++) {
    const started = performance.now()
    try {
      const res = await fetch(url, { cache: 'reload', signal: AbortSignal.timeout(15_000) })
      if (res.ok) { await res.arrayBuffer(); return `refetched on try ${i + 1} in ${Math.round(performance.now() - started)} ms` }
      // Gone from the server: a deploy removed it - only a reload onto the new version helps.
      if (res.status === 404) return 'file gone (404)'
    } catch { /* timed out / dropped - try again */ }
    await new Promise(r => setTimeout(r, 1_000 * (i + 1)))
  }
  return 'refetch failed 3 times'
}

export function lazyRetry<T extends ComponentType<any>>(
  importFn: () => Promise<{ default: T }>,
  chunkName: string,
) {
  return lazy(async () => {
    try {
      return await importFn()
    } catch (firstErr) {
      let err = firstErr
      // Offline isn't a stale build: clearing the caches and reloading now
      // would drop the app's offline copy and land on the browser's own
      // "no internet" page. Wait for the connection, then just load it.
      if (isChunkLoadError(err) && !isOnline()) {
        await new Promise<void>(resolve => { const off = onReconnect(() => { off(); resolve() }) })
        try { return await importFn() } catch (again) { err = again }
      }
      if (isChunkLoadError(err)) {
        const started = performance.now()
        const warm = await warmFailedFile(err)
        const deps = warm.startsWith('refetched') ? await repairImports(err) : ''
        const msg = String((err as any)?.message ?? err).slice(0, 300)
        void import('./errorReport').then(r => r.reportChunkFailure(
          `${chunkName} failed (${chunkContext()}; ${warm}${deps ? '; ' + deps : ''} after ${Math.round(performance.now() - started)} ms): ${msg}`,
        )).catch(() => {})
      }
      if (isChunkLoadError(err) && await recoverFromStaleBuild()) {
        // Never resolves - the reload replaces this page.
        return new Promise<{ default: T }>(() => {})
      }
      throw err
    }
  })
}
