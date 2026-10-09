// ── App updates: switch versions only when it's safe ───────────────────────
// A new version downloads in the background and waits (see sw.ts). It takes
// over — with one quick reload — only:
//   • when the app is opened (behind the opening screen), or
//   • when the app is about to reload anyway (back after a long time away).
// Never while someone is using a screen, so an update can't break it.

const GUARD_KEY = 'mp_sw_update_at'

/**
 * If a new version is waiting, switch to it and reload. Resolves false when
 * there's nothing to do (then the caller carries on as normal).
 */
export async function applyWaitingUpdate(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    const waiting = reg?.waiting
    if (!waiting || !navigator.serviceWorker.controller) return false
    // Never loop: at most one update reload every 30s.
    try {
      if (Date.now() - Number(sessionStorage.getItem(GUARD_KEY) || 0) < 30_000) return false
      sessionStorage.setItem(GUARD_KEY, String(Date.now()))
    } catch { /* private mode */ }
    await new Promise<void>(resolve => {
      const done = () => resolve()
      navigator.serviceWorker.addEventListener('controllerchange', done, { once: true })
      waiting.postMessage({ type: 'SKIP_WAITING' })
      setTimeout(done, 3000) // never hang on it
    })
    window.location.reload()
    return true
  } catch {
    return false
  }
}
