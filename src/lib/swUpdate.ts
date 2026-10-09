// ── App updates: switch versions only when it's safe ───────────────────────
// A new version downloads in the background and waits (see sw.ts). It takes
// over - with one quick reload - only:
//   • when the page loads: app opened, browser reopened, or refreshed
//     (behind the opening screen), or
//   • when the app is about to reload anyway (back after a long time away).
// Never while someone is using a screen, so an update can't break it.
//
// The browser only looks for a new version when a page loads, and a phone
// can keep the app in memory for days. So we also ask for one ourselves:
// on load, when the app comes back to the screen, and every 30 minutes.

const GUARD_KEY = 'mp_sw_update_at'
const CHECK_EVERY_MS = 30 * 60 * 1000

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return undefined
  try { return await navigator.serviceWorker.getRegistration() } catch { return undefined }
}

/** Ask the server for a new version (downloads in the background). */
export async function checkForUpdate(): Promise<void> {
  const reg = await registration()
  try { await reg?.update() } catch { /* offline - next time */ }
}

/** Resolves once a version that's downloading has finished (or after waitMs). */
function untilInstalled(reg: ServiceWorkerRegistration, waitMs: number): Promise<void> {
  const sw = reg.installing
  if (!sw || waitMs <= 0) return Promise.resolve()
  return new Promise(resolve => {
    const t = setTimeout(resolve, waitMs)
    sw.addEventListener('statechange', () => {
      if (sw.state !== 'installing') { clearTimeout(t); resolve() }
    })
  })
}

/**
 * If a new version is waiting, switch to it and reload. With `checkMs`, first
 * ask the server for one and give a download that started up to that long to
 * finish (on open the opening screen covers it). Resolves false when there's
 * nothing to do (then the caller carries on as normal).
 */
export async function applyWaitingUpdate(opts: { checkMs?: number } = {}): Promise<boolean> {
  const reg = await registration()
  if (!reg) return false
  try {
    if (!reg.waiting && opts.checkMs) {
      const started = Date.now()
      await Promise.race([reg.update().catch(() => undefined), new Promise(r => setTimeout(r, opts.checkMs))])
      await untilInstalled(reg, opts.checkMs - (Date.now() - started))
    }
    const waiting = reg.waiting
    if (!waiting || !navigator.serviceWorker.controller) return false
    // Never loop: at most one update reload every 30s.
    try {
      if (Date.now() - Number(sessionStorage.getItem(GUARD_KEY) || 0) < 30_000) return false
      sessionStorage.setItem(GUARD_KEY, String(Date.now()))
    } catch { /* private mode */ }
    showUpdating()
    // Keep the message up through the reload too (boot.js puts it back on
    // the new page's opening screen), and on screen long enough to read.
    try { sessionStorage.setItem('mp_updating', '1') } catch { /* private mode */ }
    const shownAt = Date.now()
    await new Promise<void>(resolve => {
      const done = () => resolve()
      navigator.serviceWorker.addEventListener('controllerchange', done, { once: true })
      waiting.postMessage({ type: 'SKIP_WAITING' })
      setTimeout(done, 3000) // never hang on it
    })
    await new Promise(r => setTimeout(r, Math.max(0, 900 - (Date.now() - shownAt))))
    window.location.reload()
    return true
  } catch {
    return false
  }
}

/** Keep looking for new versions while the app stays open / in memory. */
export function watchForUpdates(): () => void {
  if (typeof document === 'undefined') return () => {}
  let last = Date.now()
  const maybeCheck = () => {
    if (Date.now() - last < 60_000) return // at most once a minute
    last = Date.now()
    void checkForUpdate()
  }
  const onVisible = () => { if (document.visibilityState === 'visible') maybeCheck() }
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('online', maybeCheck)
  const timer = setInterval(() => { if (document.visibilityState === 'visible') { last = 0; maybeCheck() } }, CHECK_EVERY_MS)
  return () => {
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('online', maybeCheck)
    clearInterval(timer)
  }
}

/**
 * "Updating MeshPort…" while the new version takes over: on the opening
 * screen when it's still up, otherwise a plain screen in the page colour.
 */
function showUpdating(): void {
  try {
    const text = 'Updating MeshPort…'
    const splash = document.getElementById('splash')
    if (splash && !splash.classList.contains('splash-hide')) {
      if (splash.querySelector('.upd')) return
      const el = document.createElement('div')
      el.className = 'upd'
      el.textContent = text
      splash.appendChild(el)
      return
    }
    if (document.getElementById('mp-updating')) return
    const el = document.createElement('div')
    el.id = 'mp-updating'
    el.setAttribute('role', 'status')
    Object.assign(el.style, {
      position: 'fixed', inset: '0', zIndex: '10001', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg, #0B0E11)', color: 'var(--text-secondary, #9AA4AE)', font: '600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    })
    el.textContent = text
    document.body.appendChild(el)
  } catch { /* cosmetic only */ }
}
