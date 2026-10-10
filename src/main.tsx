import { Buffer } from 'buffer'
if (typeof window !== 'undefined') (window as any).Buffer = Buffer


// Suppress Circle SDK telemetry CORS errors - these are internal Circle logging
// calls that fail in localhost due to CORS. They don't affect functionality.
const _origFetch = window.fetch.bind(window)
window.fetch = function(input: RequestInfo | URL, init?: RequestInit) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
  if (url?.includes('api.circle.com') && url?.includes('/logs')) {
    return Promise.resolve(new Response('{}', { status: 200 }))
  }
  return _origFetch(input, init)
} as typeof fetch

// Suppress Circle SDK telemetry CORS errors on localhost
// The SDK sends logs to api.circle.com which blocks x-user-agent header from localhost
const _originalFetch = window.fetch.bind(window)
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
  if (url?.includes('api.circle.com') && url?.includes('/logs')) {
    return Promise.resolve(new Response('{}', { status: 200 }))
  }
  return _originalFetch(input, init)
}) as typeof fetch

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { clearLegacyData } from './lib/clearLegacyData'
import { recoverFromStaleBuild, markBuildHealthy } from './lib/lazyRetry'

// A chunk preload failing (app updated while this tab was open) → reload onto
// the new build instead of crashing. Once the app has run fine for a bit,
// reset the retry counter so the next deploy gets fresh retries too.
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault()
  recoverFromStaleBuild()
})
window.setTimeout(markBuildHealthy, 15_000)
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
  // app was hidden; 15 min, same as there).
  let awayTooLong = false
  try {
    const hiddenAt = Number(sessionStorage.getItem('meshport:hidden-at') || 0)
    awayTooLong = hiddenAt > 0 && Date.now() - hiddenAt > 15 * 60 * 1000
    sessionStorage.removeItem('meshport:hidden-at')
  } catch { /* private mode */ }
  const auth = useAuthStore.getState()
  if ((!hadSession || awayTooLong) && auth.isAuthenticated && auth.passcodeLockEnabled && !auth.isLocked) auth.lock()
  // Start fetching the lock screen now, so the splash goes straight to it.
  if (useAuthStore.getState().isLocked) {
    import('./features/auth/PasscodeSetup').catch(() => {})
    // And Home behind it, so it shows the instant the fingerprint / passcode
    // is accepted instead of loading only then (~1s on a mid-range phone).
    setTimeout(() => { import('./features/home/HomePage').catch(() => {}) }, 400)
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
