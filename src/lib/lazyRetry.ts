import { lazy, type ComponentType } from 'react'

// ── lazyRetry — resilient wrapper around React.lazy ─────────────────────────
//
// Every route in App.tsx is lazy-loaded, which means each one fetches its own
// small JS chunk (e.g. "PaySendPage-DEkHri5M.js") the first time that route is
// visited. Vite content-hashes those filenames, so a new deployment replaces
// old chunk files with new ones under new hashes — the old files are gone.
//
// If someone already has the app open (or a browser/PWA cache) from BEFORE a
// new deployment, and then navigates to a route whose chunk changed, the
// browser tries to fetch a filename that no longer exists on the server and
// the dynamic import() throws "Failed to fetch dynamically imported module".
// Without handling, that crashes the whole app with an ugly error screen —
// even though the fix is as simple as reloading to get the current build.
//
// This wraps every lazy() call so that failure instead triggers ONE
// automatic full-page reload (fetching the fresh index.html + current chunk
// manifest), which resolves the vast majority of cases invisibly. A
// sessionStorage flag prevents an infinite reload loop if the app is
// genuinely unreachable (e.g. offline, or the deployment itself is broken).
export function lazyRetry<T extends ComponentType<any>>(
  importFn: () => Promise<{ default: T }>,
  chunkName: string,
) {
  return lazy(async () => {
    const retryKey = `meshport_chunk_retry_${chunkName}`
    // Cooldown-based instead of a permanent "already retried this session"
    // flag — during a burst of several deploys close together (e.g. active
    // iteration), a second failure minutes later is a genuinely NEW stale
    // reference against the latest deploy, not a repeat of the first. A
    // permanent flag would block that second, legitimate retry until the
    // tab closes. 30s is long enough that a true infinite-loop-on-broken-
    // deployment case still gets stopped quickly, short enough that it
    // won't block a real subsequent deploy.
    const RETRY_COOLDOWN_MS = 30_000
    try {
      const module = await importFn()
      sessionStorage.removeItem(retryKey)
      return module
    } catch (err) {
      const lastRetryAt = Number(sessionStorage.getItem(retryKey) || 0)
      const cooledDown = !lastRetryAt || (Date.now() - lastRetryAt) > RETRY_COOLDOWN_MS
      if (cooledDown) {
        sessionStorage.setItem(retryKey, String(Date.now()))
        window.location.reload()
        // Never resolves — the reload replaces this page entirely.
        return new Promise<{ default: T }>(() => {})
      }
      // Retried within the last 30s and it still failed — a real problem
      // (offline, deployment down, etc), not just a stale-chunk mismatch.
      // Let it surface normally rather than reload-looping forever.
      throw err
    }
  })
}
