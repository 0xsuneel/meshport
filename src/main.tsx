import { Buffer } from 'buffer'
if (typeof window !== 'undefined') (window as any).Buffer = Buffer


import React from 'react'
import ReactDOM from 'react-dom/client'
import { MotionConfig } from 'framer-motion'
// Before App (and its router): the leave guard's Back listener must be added
// ahead of React Router's - window listeners run in the order they're added.
import './lib/leaveGuard'
// No iPhone zoom-in on small text fields (they're raised to 16px on touch).
import './lib/inputZoomGuard'
import App from './App.tsx'
// Geist, self-hosted (no Google Fonts request on every open).
import '@fontsource-variable/geist'
import './index.css'
import { clearLegacyData } from './lib/clearLegacyData'
import { recoverFromStaleBuild, markBuildHealthy, onVitePreloadError, isChunkLoadError } from './lib/lazyRetry'

// A file of an older version failing to load (app updated while this tab was
// open, or an old installed page on a slow network) → reload onto the current
// build. The import is left to throw (see onVitePreloadError): lazyRetry
// reloads for a page, the unhandledrejection handler below for anything else.
// Once the app has run fine for a bit, reset the retry counter so the next
// deploy gets fresh retries too.
window.addEventListener('vite:preloadError', onVitePreloadError)
window.setTimeout(markBuildHealthy, 15_000)
// The app's stylesheet failed (an older index.html whose CSS a deploy
// replaced): the app would run with no styles at all - reload onto the
// current build instead.
{
  const css = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"][href*="/assets/"]')
  if (css && !css.sheet) {
    const failed = () => { if (!css.sheet) void recoverFromStaleBuild() }
    css.addEventListener('error', failed)
    window.addEventListener('load', failed, { once: true })
  }
}
// Uncaught errors reach client_errors too (the error screen reports its own).
window.addEventListener('error', e => { void import('./lib/errorReport').then(m => m.reportClientError('uncaught', e.error ?? e.message)) })
window.addEventListener('unhandledrejection', e => {
  if (isChunkLoadError(e.reason)) void recoverFromStaleBuild()
  void import('./lib/errorReport').then(m => m.reportClientError('rejection', e.reason))
})
// The ?_v=… an update reload adds is only for the service worker's handling of
// that one page load (sw.ts) - take it out of the address bar straight away so
// the app never shows meshport.xyz/?_v=123… instead of the normal address.
try {
  const u = new URL(window.location.href)
  if (u.searchParams.has('_v')) {
    u.searchParams.delete('_v')
    window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash)
  }
} catch { /* ignore */ }
import './store/themeStore'
import { useAuthStore } from './store'
import { startWalletReadiness } from './lib/walletReadiness'
import { awayPastAutoLock } from './lib/autoLock'
import { installGlassHeaders } from './lib/glassHeaders'
import { installViewportDebug } from './lib/viewportDebug'

// Clear all legacy mock/fake data from localStorage on startup
clearLegacyData()

// Lock on a fresh launch BEFORE the first render (see the long comment on
// this rule in App.tsx). Doing it in an effect let Home paint first and
// then swap to the lock screen - opening from the home screen showed a flash
// of Home before the fingerprint prompt. The persisted auth store hydrates
// synchronously from localStorage, so it can be decided right here.
{
  const SESSION_FLAG = 'meshport:session-alive'
  let hadSession = true
  try { hadSession = sessionStorage.getItem(SESSION_FLAG) === '1'; sessionStorage.setItem(SESSION_FLAG, '1') } catch { /* private mode */ }
  // Also lock when this is a reload of a tab the phone discarded after it
  // sat in the background past the auto-lock time (App.tsx records when the
  // app was hidden; the same 5 minutes as there - lib/autoLock.ts).
  let awayTooLong = false
  try {
    const hiddenAt = Number(sessionStorage.getItem('meshport:hidden-at') || 0)
    awayTooLong = awayPastAutoLock(hiddenAt, Date.now())
    sessionStorage.removeItem('meshport:hidden-at')
  } catch { /* private mode */ }
  // A wallet kind this version no longer has (a removed provider, saved on
  // this device by an older version): sign out cleanly, so the next sign-in
  // sets up the wallet this version uses.
  const KNOWN_SOURCES = new Set(['create', 'import-seed', 'import-privkey'])
  const savedSource = useAuthStore.getState().walletSource as string | null
  if (savedSource && !KNOWN_SOURCES.has(savedSource)) useAuthStore.getState().logout()
  const auth = useAuthStore.getState()
  if ((!hadSession || awayTooLong) && auth.isAuthenticated && auth.passcodeLockEnabled && !auth.isLocked) auth.lock()
  if (useAuthStore.getState().isLocked) void import('./lib/perfTrace').then(m => m.noteStartedLocked()).catch(() => {})
  // Wallet readiness (lib/walletReadiness): tracking starts before the first
  // render, so the first Arc answer and the first open are both seen.
  startWalletReadiness()
  // The wallet frame: loaded now, so it is ready (or reloading if its first
  // load failed - wallet/frameClient.ts) by the time the lock screen or the
  // first payment needs it.
  // Also on the sign-in screens: Create / Import then answer at once instead
  // of loading the frame only when tapped (field 7 Nov: 10-18 s on 4G).
  const onAuthScreen = location.pathname === '/auth' || location.pathname.startsWith('/auth/')
  if ((auth.isAuthenticated && auth.walletSource) || onAuthScreen) import('./wallet/frameClient').then(m => m.walletReady()).catch(() => {})
  // Start fetching the lock screen now, so the splash goes straight to it.
  if (useAuthStore.getState().isLocked) import('./features/auth/PasscodeSetup').catch(() => {})
  if (auth.isAuthenticated && auth.walletAddress) {
    // Home and the balance reads start now, behind the lock screen - not
    // after unlock. Field 7 Nov (first open after a release): Home's code
    // was still downloading 9 s after the passcode, so the first balance
    // read went out at 12 s. The reads fill the shared cache Home reads from.
    import('./features/home/HomePage').catch(() => {})
    const wallet = auth.walletAddress
    void import('./blockchain/BlockchainManager').then(m => {
      for (const asset of ['USDC', 'EURC', 'CIRBTC'] as const) m.readArcBalance(wallet, asset).catch(() => {})
    }).catch(() => {})
    void import('./lib/payIntentService').then(m => { void m.warmPayIntent() }).catch(() => {})
  }
}

// Page loading (app opened, browser reopened or refreshed): if a new version
// is out, switch to it now behind the opening screen, instead of mid-use
// later. Asks the server too, and gives a download that started a moment to
// finish. Refreshes count: a restored browser tab looks like a refresh, and
// skipping those meant a reopened app could stay on the old version.
void import('./lib/swUpdate').then(m => {
  void m.applyWaitingUpdate({ checkMs: 3000 })
  m.watchForUpdates()
})

installGlassHeaders()
installViewportDebug()
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* Phone set to reduce motion: framer animations drop their movement
        (slides, grows) and keep fades - the CSS side is in index.css. */}
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </React.StrictMode>,
)
