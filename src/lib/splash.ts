// The opening splash (index.html #splash) — lets the lock screen wait until
// it has gone before opening the fingerprint / Face ID prompt.
let done = typeof document === 'undefined' || !document.getElementById('splash')
const waiters = new Set<() => void>()

export function markSplashDone() {
  done = true
  waiters.forEach(f => f())
  waiters.clear()
}

/** Runs `fn` once the splash is gone (at once if it already is). Returns a cancel. */
export function afterSplash(fn: () => void): () => void {
  if (done || !document.getElementById('splash')) { fn(); return () => {} }
  waiters.add(fn)
  return () => { waiters.delete(fn) }
}
