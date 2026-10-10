// ── App updates: switch versions only when it's safe ───────────────────────
// How it works now (like X, Gmail, Slack and other web apps):
//   • Opening or refreshing the app loads the live page from the server
//     (sw.ts), so it is already the newest version - nothing to wait for.
//   • Every deploy publishes /version.json (vite.config.ts). The open app
//     compares it with its own build (__MP_BUILD__) on load, when it comes
//     back to the screen and every minute - a ~50-byte check - and switches
//     with one quick reload as soon as it's safe (watchForUpdates below).
//   • The service worker's new offline copy downloads in the background and
//     takes over quietly once the page is on the new version (no reload).
// Never in the middle of something, so an update can't break it.

import { meshLoaderSvgMarkup } from '@/components/ui/MeshLoader'

const GUARD_KEY = 'mp_sw_update_at'
const TARGET_KEY = 'mp_sw_update_to' // the version an update reload was meant to land on
const MY_BUILD: string = typeof __MP_BUILD__ === 'string' ? __MP_BUILD__ : ''
let newerBuild: string | null = null
let upToDate = false // the server confirmed this page is the live version

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return undefined
  try { return await navigator.serviceWorker.getRegistration() } catch { return undefined }
}

/** The build that is live on the server, or null when it can't be read (offline). */
async function liveBuild(timeoutMs = 5000): Promise<string | null> {
  try {
    const res = await fetch('/version.json', { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const j = await res.json()
    return typeof j?.build === 'string' && j.build ? j.build : null
  } catch { return null }
}

/** Ask the server whether a newer version is live (and let the offline copy update). */
export async function checkForUpdate(): Promise<boolean> {
  void registration().then(reg => reg?.update().catch(() => undefined))
  const live = await liveBuild()
  if (live && MY_BUILD) {
    if (live !== MY_BUILD) newerBuild = live
    else upToDate = true
  }
  return !!newerBuild
}

/** This page is the live version: let a waiting offline copy take over, quietly. */
async function adoptWaitingCopy(): Promise<void> {
  if (!upToDate || newerBuild) return // an older page still needs the old copy's files
  const reg = await registration()
  try { reg?.waiting?.postMessage({ type: 'SKIP_WAITING' }) } catch { /* next time */ }
}

/** Resolves once a new offline copy is waiting (or after `ms`). */
async function untilWaiting(reg: ServiceWorkerRegistration, ms: number): Promise<void> {
  const end = Date.now() + ms
  while (!reg.waiting && Date.now() < end) {
    if (!reg.installing) { try { await reg.update() } catch { /* offline */ } }
    await new Promise(r => setTimeout(r, 250))
  }
}

/** Reload onto the live version, with "Updating MeshPort…" on screen. */
async function switchToNewVersion(): Promise<boolean> {
  // Never loop: at most one update reload every 30s.
  try {
    if (Date.now() - Number(sessionStorage.getItem(GUARD_KEY) || 0) < 30_000) return false
    sessionStorage.setItem(GUARD_KEY, String(Date.now()))
  } catch { /* private mode */ }
  showUpdating()
  // Keep the message up through the reload too (boot.js puts it back on
  // the new page's opening screen), and on screen long enough to read.
  try {
    sessionStorage.setItem('mp_updating', '1')
    if (newerBuild) sessionStorage.setItem(TARGET_KEY, newerBuild) // checked after the reload
  } catch { /* private mode */ }
  const shownAt = Date.now()
  const reg = await registration()
  if (reg && navigator.serviceWorker.controller) {
    // The offline copy in charge answers the reload. An older one (from before
    // pages were loaded live) answers with the OLD page - which is how
    // "Update ready" kept coming back after every tap. So: let the new copy
    // finish installing and take over first; if it can't in time, remove the
    // old copy so the reload has to come from the server (it re-installs).
    await untilWaiting(reg, 10_000)
    const waiting = reg.waiting
    if (waiting) {
      await new Promise<void>(resolve => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })
        waiting.postMessage({ type: 'SKIP_WAITING' })
        setTimeout(resolve, 3000) // never hang on it
      })
    } else {
      try { await reg.unregister() } catch { /* reload anyway */ }
    }
  }
  await new Promise(r => setTimeout(r, Math.max(0, 700 - (Date.now() - shownAt))))
  // ?_v tells the service worker to wait for the live page rather than open
  // the installed copy after 2s (sw.ts); markBuildHealthy() tidies it away.
  const url = new URL(window.location.href)
  url.searchParams.set('_v', String(Date.now()))
  window.location.replace(url.toString())
  return true
}

/**
 * Page load, or about to reload anyway: if a newer version is live, switch
 * to it now and resolve true. Otherwise (already the newest, or offline)
 * resolve false - and a waiting offline copy takes over quietly.
 */
export async function applyWaitingUpdate(_opts: { checkMs?: number } = {}): Promise<boolean> {
  let target: string | null = null
  try { target = sessionStorage.getItem(TARGET_KEY); sessionStorage.removeItem(TARGET_KEY) } catch { /* private mode */ }
  if (await checkForUpdate()) {
    // We just reloaded for this very version and still came back on the old
    // one: the device's offline copy keeps answering with the old page. Clear
    // it completely and load from the server (lib/lazyRetry - it stops after
    // two tries, so this can't loop).
    if (target && target === newerBuild) {
      const { recoverFromStaleBuild } = await import('./lazyRetry')
      if (await recoverFromStaleBuild()) return true
    }
    return switchToNewVersion()
  }
  void adoptWaitingCopy()
  return false
}

// ── Updates while the app is open ──────────────────────────────────────────
// A new deploy is noticed within a minute (/version.json, ~50 bytes). The app
// never reloads while it's on screen:
//   • it switches the moment the app goes to the background, on a "resting"
//     screen (Home, Chats list, Activity, News, P2P lists, Profile, lock
//     screen…) - or on the next open (applyWaitingUpdate);
//   • meanwhile a small "Update ready" pill lets the person update right away.
// Never on screens where money can be moving (Pay, Swap, Bulk, Transfer /
// Bring, Receive request, Rewards claim, a chat, a P2P trade).
const CHECK_OPEN_MS = 60 * 1000
const RESTING = [
  /^\/$/, /^\/chat\/?$/, /^\/activity\/?$/, /^\/insights\/?$/, /^\/news(\/.*)?$/, /^\/notifications\/?$/,
  /^\/recent-paid\/?$/, /^\/p2p\/?$/, /^\/p2p\/my-(offers|trades)\/?$/, /^\/profile\/?$/, /^\/contacts\/?$/,
  /^\/auth\/lock\/?$/,
]

function onRestingScreen(): boolean {
  return RESTING.some(r => r.test(window.location.pathname))
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
    el.addEventListener('click', () => { el.remove(); void switchToNewVersion() })
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
    void checkForUpdate().then(found => { if (found) void tryApply() })
  }
  // The new offline copy finished downloading after this (live) page loaded.
  void registration().then(reg => reg?.addEventListener('updatefound', () => {
    const sw = reg.installing
    sw?.addEventListener('statechange', () => { if (sw.state === 'installed') void adoptWaitingCopy() })
  }))
  // Never reload while the person is looking at the app: switch only once it
  // goes to the background on a resting screen (or on the next open, see
  // applyWaitingUpdate). While it's on screen, the "Update ready" pill lets
  // them update right away if they want to.
  const tryApply = async () => {
    if (!newerBuild) return
    if (document.visibilityState === 'hidden') {
      if (onRestingScreen()) {
        document.getElementById('mp-update-ready')?.remove()
        void switchToNewVersion()
      }
    } else {
      showReadyPill()
    }
  }
  const onVisibility = () => {
    if (document.visibilityState === 'visible') maybeCheck()
    else void tryApply() // going to the background: switch now if it's safe
  }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('online', maybeCheck)
  const checkTimer = setInterval(() => { if (document.visibilityState === 'visible') { last = 0; maybeCheck() } }, CHECK_OPEN_MS)
  const applyTimer = setInterval(() => { void tryApply() }, 2000)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('online', maybeCheck)
    clearInterval(checkTimer); clearInterval(applyTimer)
  }
}

/**
 * "Updating MeshPort…" while the new version takes over: on the opening
 * screen when it's still up, otherwise a plain screen in the page colour.
 */
export function showUpdating(): void {
  try {
    const text = 'Updating MeshPort…'
    // The animated logo: on the opening screen its logo starts pulsing (index.html).
    document.documentElement.classList.add('mp-updating')
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
      position: 'fixed', inset: '0', zIndex: '10001', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '18px',
      background: 'var(--bg, #0B0E11)', color: 'var(--text-secondary, #9AA4AE)', font: '600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    })
    const logo = document.createElement('div')
    const label = document.createElement('div')
    label.textContent = text
    el.append(logo, label)
    document.body.appendChild(el)
    // Same animated MeshPort logo as the app's loaders (MeshLoader).
    logo.innerHTML = meshLoaderSvgMarkup(64, 'var(--mesh-loader, #5CD6CB)')
  } catch { /* cosmetic only */ }
}
