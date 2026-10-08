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
// So a tiny request (eth_chainId) through the app's own Arc RPC route — the
// same one balances use — confirms it: at start, while offline (every few
// seconds), and before announcing "back online".

import { useEffect, useRef, useSyncExternalStore } from 'react'

const PROBE_URL = '/api/arc-rpc' // ARC_RPCS[0] in blockchain/chains.ts
const PROBE_TIMEOUT_MS = 4000
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

/** One small request that only succeeds when the internet really works. */
export function probeConnection(): Promise<boolean> {
  if (probing) return probing
  probing = (async () => {
    try {
      const r = await fetch(PROBE_URL, {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
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
    if (document.visibilityState === 'visible' && !online) void check()
  })
  if (!online) startPolling()
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
