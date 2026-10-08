// ── Connectivity: one place that knows when the internet comes back ────────
// Pages load their data when they open. Before this, a load that failed while
// offline stayed failed until the user refreshed. Now anything that loads
// data can `useOnReconnect(reload)` and runs again by itself the moment the
// connection returns, like other apps do. `useOnline()` drives the "No
// internet connection" / "Back online" banner (OfflineBanner).

import { useEffect, useRef, useSyncExternalStore } from 'react'

// The OS reports "online" as soon as a network is attached; DNS and the first
// requests often still fail for a moment, so reloads wait a little.
const SETTLE_MS = 800

let online = typeof navigator === 'undefined' ? true : navigator.onLine !== false
const stateListeners = new Set<() => void>()
const reconnectListeners = new Set<() => void>()
let settleTimer: ReturnType<typeof setTimeout> | null = null
let reconnects = 0

function setOnline(next: boolean) {
  if (next === online) return
  online = next
  stateListeners.forEach(l => l())
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null }
  if (next) {
    settleTimer = setTimeout(() => {
      settleTimer = null
      if (!online) return
      reconnects += 1
      reconnectListeners.forEach(l => { try { l() } catch (e) { console.warn('[connectivity] reload failed:', e) } })
    }, SETTLE_MS)
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => setOnline(true))
  window.addEventListener('offline', () => setOnline(false))
}

export function isOnline(): boolean { return online }

/** Runs `fn` each time the connection comes back. Returns an unsubscribe. */
export function onReconnect(fn: () => void): () => void {
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

/** Calls the latest `fn` whenever the connection comes back (while mounted). */
export function useOnReconnect(fn: () => void): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => onReconnect(() => ref.current()), [])
}

/**
 * A number that goes up each time the connection comes back. Put it in a
 * data-loading effect's dependencies to re-run that load on reconnect.
 */
export function useReconnectCount(): number {
  return useSyncExternalStore(
    l => onReconnect(l),
    () => reconnects,
    () => 0,
  )
}

/** Test hook: drive the state without real network events. */
export function __setOnlineForTest(next: boolean): void { setOnline(next) }
