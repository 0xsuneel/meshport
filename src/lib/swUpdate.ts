// ── App updates: switch versions only when it's safe ───────────────────────
// A new version downloads in the background and waits (see sw.ts). It takes
// over - with one quick reload - only:
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
