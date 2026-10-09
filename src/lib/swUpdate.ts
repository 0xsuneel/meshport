// ── App updates: switch versions only when it's safe ───────────────────────
// A new version downloads in the background and waits (see sw.ts). It takes
// over - with one quick reload - only:
//   • when the page loads: app opened, browser reopened, or refreshed
//     (behind the opening screen), or
//   • when the app is about to reload anyway (back after a long time away), or
//   • while open, on a resting screen nobody is touching (watchForUpdates).
// Never in the middle of something, so an update can't break it.
//
// The browser only looks for a new version when a page loads, and a phone
// can keep the app in memory for days. So we also ask for one ourselves:
// on load, when the app comes back to the screen, and every minute while
// it's open (see watchForUpdates below for switching while open).

const GUARD_KEY = 'mp_sw_update_at'

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

// ── Instant updates while the app is open ──────────────────────────────────
// A new deploy is noticed within a minute (cheap: the browser re-checks the
// small sw.js file) and switched to as soon as it is safe:
//   • right away on a "resting" screen (Home, Chats list, Activity, News,
//     P2P lists, Profile, lock screen…) once nobody has touched the screen
//     for a few seconds, nothing is being typed and no popup is open;
//   • the moment the app goes to the background, on those same screens;
//   • otherwise a small "Update ready" pill - tap it to update now; it also
//     updates by itself once you're back on a resting screen.
// Never on screens where money can be moving (Pay, Swap, Bulk, Transfer /
// Bring, Receive request, Rewards claim, a chat, a P2P trade).
const CHECK_OPEN_MS = 60 * 1000
const IDLE_MS = 4000
const RESTING = [
  /^\/$/, /^\/chat\/?$/, /^\/activity\/?$/, /^\/insights\/?$/, /^\/news(\/.*)?$/, /^\/notifications\/?$/,
  /^\/recent-paid\/?$/, /^\/p2p\/?$/, /^\/p2p\/my-(offers|trades)\/?$/, /^\/profile\/?$/, /^\/contacts\/?$/,
  /^\/auth\/lock\/?$/,
]
let lastInput = Date.now()

function onRestingScreen(): boolean {
  return RESTING.some(r => r.test(window.location.pathname))
}
function safeToSwitchNow(): boolean {
  if (!onRestingScreen()) return false
  const el = document.activeElement as HTMLElement | null
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return false
  if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return false
  return Date.now() - lastInput >= IDLE_MS
}

function showReadyPill(): void {
  try {
    if (document.getElementById('mp-update-ready')) return
    const el = document.createElement('button')
    el.id = 'mp-update-ready'
    el.type = 'button'
    el.textContent = 'Update ready · Tap to update'
    Object.assign(el.style, {
      position: 'fixed', left: '50%', transform: 'translateX(-50%)', zIndex: '10000',
      top: 'calc(env(safe-area-inset-top, 0px) + 10px)', padding: '8px 14px', borderRadius: '999px',
      border: 'none', background: 'var(--brand, #12665F)', color: '#fff', cursor: 'pointer',
      font: '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
    })
    el.addEventListener('click', () => { el.remove(); void applyWaitingUpdate() })
    document.body.appendChild(el)
  } catch { /* cosmetic only */ }
}

/** Keep looking for new versions while the app stays open / in memory, and switch as soon as it's safe. */
export function watchForUpdates(): () => void {
  if (typeof document === 'undefined' || !('serviceWorker' in navigator)) return () => {}
  let last = Date.now()
  const maybeCheck = () => {
    if (Date.now() - last < 30_000) return
    last = Date.now()
    void checkForUpdate()
  }
  const markInput = () => { lastInput = Date.now() }
  const tryApply = async () => {
    const reg = await registration()
    if (!reg?.waiting || !navigator.serviceWorker.controller) return
    if (document.visibilityState === 'hidden' ? onRestingScreen() : safeToSwitchNow()) {
      document.getElementById('mp-update-ready')?.remove()
      void applyWaitingUpdate()
    } else if (document.visibilityState === 'visible') {
      showReadyPill()
    }
  }
  const onVisibility = () => {
    if (document.visibilityState === 'visible') maybeCheck()
    else void tryApply() // going to the background: switch now if it's safe
  }
  // A new version that finishes downloading while we're open.
  void registration().then(reg => reg?.addEventListener('updatefound', () => {
    const sw = reg.installing
    sw?.addEventListener('statechange', () => { if (sw.state === 'installed') void tryApply() })
  }))
  for (const ev of ['pointerdown', 'keydown', 'touchstart', 'wheel']) window.addEventListener(ev, markInput, { passive: true, capture: true })
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('online', maybeCheck)
  const checkTimer = setInterval(() => { if (document.visibilityState === 'visible') { last = 0; maybeCheck() } }, CHECK_OPEN_MS)
  const applyTimer = setInterval(() => { void tryApply() }, 2000)
  return () => {
    for (const ev of ['pointerdown', 'keydown', 'touchstart', 'wheel']) window.removeEventListener(ev, markInput, { capture: true })
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('online', maybeCheck)
    clearInterval(checkTimer); clearInterval(applyTimer)
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
