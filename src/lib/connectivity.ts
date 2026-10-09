// ── Connectivity: one place that knows when the internet is really there ───
// Pages load their data when they open. Before this, a load that failed while
// offline stayed failed until the user refreshed. Now anything that loads
// data can `useOnReconnect(reload)` and runs again by itself once the
// connection is back, like other apps do. `useOnline()` drives the "No
// internet connection" / "Back online" banner (OfflineBanner).
//
// The browser's own online flag isn't trusted on its own: on Android it often
// says "online" after a refresh with no internet (a network is attached but
// nothing gets through), and the "online" event fires before requests work.
// So a tiny request (eth_chainId) through the app's own Arc RPC route - the
// same one balances use - confirms it: at start, while offline (every few
// seconds), and before announcing "back online".

import { useEffect, useRef, useSyncExternalStore } from 'react'

const PROBE_URL = '/api/arc-rpc' // ARC_RPCS[0] in blockchain/chains.ts
// Long enough for a very weak link (~1 KB/s) to answer: a slow answer means
// "slow", not "offline". Nothing at all within this time is offline.
const PROBE_TIMEOUT_MS = 12000
// A probe slower than this → slow network (the app then saves data: the
// balance goes first, extras wait - see isSlowNetwork()).
const SLOW_PROBE_MS = 4000
// While slow, check again this often to notice the network getting better.
const SLOW_RECHECK_MS = 30_000
const SLOW_HINT_KEY = 'mp_net_slow_at'
const OFFLINE_POLL_MS = 4000
// After the connection is confirmed, loads run at once and once more a few
// seconds later (some services answer a moment after the network does).
const SECOND_WAVE_MS = 5000

export type ReconnectWave = 0 | 1

let online = typeof navigator === 'undefined' ? true : navigator.onLine !== false
const stateListeners = new Set<() => void>()
const reconnectListeners = new Set<(wave: ReconnectWave) => void>()
let reconnects = 0
let pollTimer: ReturnType<typeof setInterval> | null = null
let waveTimer: ReturnType<typeof setTimeout> | null = null
let probing: Promise<boolean> | null = null

// ── Slow network ─────────────────────────────────────────────────────────
// Online but very slow (e.g. 1 KB/s): every request shares that pipe, so the
// app sends the balance first and holds back extras (other-chain scans,
// prices, catch-ups) until the network is better.
const slowListeners = new Set<() => void>()
let slowTimer: ReturnType<typeof setInterval> | null = null
function browserSaysSlow(): boolean {
  const c = typeof navigator !== 'undefined' ? (navigator as any).connection : null
  return !!c && (c.saveData === true || c.effectiveType === 'slow-2g' || c.effectiveType === '2g')
}
function recentlySlow(): boolean {
  try { return Date.now() - Number(sessionStorage.getItem(SLOW_HINT_KEY) || 0) < 10 * 60_000 } catch { return false }
}
// Starts from the browser's hint and from this tab's last measurement, so a
// reload on a weak link doesn't fire every extra request before measuring.
let slow = typeof window !== 'undefined' && (browserSaysSlow() || recentlySlow())

function setSlow(next: boolean) {
  if (next === slow) return
  slow = next
  try { next ? sessionStorage.setItem(SLOW_HINT_KEY, String(Date.now())) : sessionStorage.removeItem(SLOW_HINT_KEY) } catch { /* private mode */ }
  if (next && !slowTimer && typeof window !== 'undefined') slowTimer = setInterval(() => { void check() }, SLOW_RECHECK_MS)
  if (!next && slowTimer) { clearInterval(slowTimer); slowTimer = null }
  slowListeners.forEach(l => { try { l() } catch (e) { console.warn('[connectivity] slow listener failed:', e) } })
}

/**
 * A real request (e.g. the balance) took this long: a very slow one switches
 * on slow mode without waiting for the next probe.
 */
export function noteRequestTime(ms: number): void {
  if (ms > 6000 && online) setSlow(true)
}

/** True while the connection works but is very slow. */
export function isSlowNetwork(): boolean { return slow }

/** Live slow-network state for UI and effects. */
export function useSlowNetwork(): boolean {
  return useSyncExternalStore(
    l => { slowListeners.add(l); return () => { slowListeners.delete(l) } },
    () => slow,
    () => false,
  )
}

/**
 * Runs `fn` now on a normal connection, or once the network is no longer
 * slow (for work that isn't needed to show the balance). Returns a cancel.
 */
export function whenNetworkOk(fn: () => void): () => void {
  if (!slow) { fn(); return () => {} }
  const l = () => { if (!slow) { slowListeners.delete(l); fn() } }
  slowListeners.add(l)
  return () => { slowListeners.delete(l) }
}

/** One small request that only succeeds when the internet really works. */
export function probeConnection(): Promise<boolean> {
  if (probing) return probing
  probing = (async () => {
    const started = Date.now()
    try {
      const r = await fetch(PROBE_URL, {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (r.ok) setSlow(browserSaysSlow() || Date.now() - started > SLOW_PROBE_MS)
      return r.ok
    } catch {
      return false
    } finally {
      probing = null
    }
  })()
  return probing
}

function emit(wave: ReconnectWave) {
  if (!online) return
  reconnects += 1
  reconnectListeners.forEach(l => { try { l(wave) } catch (e) { console.warn('[connectivity] reload failed:', e) } })
}

function setOnline(next: boolean) {
  if (next === online) return
  online = next
  stateListeners.forEach(l => l())
  if (waveTimer) { clearTimeout(waveTimer); waveTimer = null }
  if (next) {
    stopPolling()
    emit(0)
    waveTimer = setTimeout(() => { waveTimer = null; emit(1) }, SECOND_WAVE_MS)
  } else {
    startPolling()
  }
}

function startPolling() {
  if (pollTimer || typeof window === 'undefined') return
  pollTimer = setInterval(() => { void check() }, OFFLINE_POLL_MS)
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

/** Confirm the current state with a real request, and update it. */
async function check(): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) { setOnline(false); return }
  setOnline(await probeConnection())
}

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => setOnline(false))
  // The OS says a network is back: confirm before telling anyone.
  window.addEventListener('online', () => { void check() })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!online || slow)) void check()
  })
  if (!online) startPolling()
  if (slow) slowTimer = setInterval(() => { void check() }, SLOW_RECHECK_MS)
  // The browser noticed the link type change (e.g. 2G → 4G): measure again.
  ;(navigator as any).connection?.addEventListener?.('change', () => { void check() })
  // At start (including a refresh while offline): confirm the flag.
  setTimeout(() => { void check() }, 1200)
}

export function isOnline(): boolean { return online }

/**
 * Runs `fn` each time the connection comes back: wave 0 at once, wave 1 a few
 * seconds later. Returns an unsubscribe.
 */
export function onReconnect(fn: (wave: ReconnectWave) => void): () => void {
  reconnectListeners.add(fn)
  return () => { reconnectListeners.delete(fn) }
}

/** Live online/offline state for UI. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    l => { stateListeners.add(l); return () => { stateListeners.delete(l) } },
    () => online,
    () => true,
  )
}

/** Calls the latest `fn` whenever the connection comes back (both waves, while mounted). */
export function useOnReconnect(fn: (wave: ReconnectWave) => void): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => onReconnect(w => ref.current(w)), [])
}

/**
 * A number that goes up each time the connection comes back (both waves).
 * Put it in a data-loading effect's dependencies to re-run that load.
 */
export function useReconnectCount(): number {
  return useSyncExternalStore(
    l => onReconnect(() => l()),
    () => reconnects,
    () => 0,
  )
}

/** Test hook: drive the state without real network events. */
export function __setOnlineForTest(next: boolean): void { setOnline(next) }
/** Test hook: drive the slow state. */
export function __setSlowForTest(next: boolean): void { setSlow(next) }
