// ── Median (median.co) app shell ────────────────────────────────────────────
// The iOS / Android apps built with Median show this site in the phone's own
// web view, under a native status bar. That bar ignores the page's
// <meta name="theme-color"> (which the browser and the installed web app
// follow), so by default it stays the colour set in Median's dashboard
// whatever theme MeshPort is in. Median's JavaScript bridge (`window.median`,
// injected only inside its apps) lets the page set it: the same colour as the
// page, with dark or light icons to match. Outside a Median app none of this
// runs.
//
// Overlay: the page also draws BEHIND the status bar, so the frosted header
// (index.css "Frosted bars") runs up under the clock and battery like a native
// app. That needs the web view to report the bar's height as the top safe
// area (env(safe-area-inset-top)) - every header pads by it. A web view that
// reports 0 would put the header under the clock, so it is checked once: no
// top inset with the overlay on → back to the solid bar, and remembered.

export type StatusBarOptions = { style: 'light' | 'dark'; color: string; overlay: boolean }

type MedianBridge = { statusbar?: { set?: (o: StatusBarOptions) => void } }
type MedianWindow = Window & { median?: MedianBridge; median_library_ready?: () => void }

const OVERLAY_KEY = 'mp_statusbar_overlay' // 'yes' | 'no' once checked on this device
const CHECK_AFTER_MS = 600

function overlayVerdict(): 'yes' | 'no' | null {
  try { const v = localStorage.getItem(OVERLAY_KEY); return v === 'yes' || v === 'no' ? v : null } catch { return null }
}

/** Status bar for a page in this theme: the page's background, readable icons. */
export function statusBarFor(theme: 'light' | 'dark', overlay = false): StatusBarOptions {
  return theme === 'dark'
    ? { style: 'light', color: '000000', overlay } // light icons on black
    : { style: 'dark', color: 'F5F4F0', overlay }  // dark icons on the warm page
}

let pending: 'light' | 'dark' | null = null
let hooked = false
let checking = false

/** The page's top safe area right now, in px (0 when there is none). */
export function topInsetPx(): number {
  if (typeof document === 'undefined' || !document.body) return 0
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;height:env(safe-area-inset-top,0px)'
  document.body.appendChild(probe)
  const h = probe.getBoundingClientRect().height
  probe.remove()
  return h
}

function apply(w: MedianWindow, theme: 'light' | 'dark'): boolean {
  const set = w.median?.statusbar?.set
  if (typeof set !== 'function') return false
  const verdict = overlayVerdict()
  const overlay = verdict !== 'no'
  try { set.call(w.median!.statusbar, statusBarFor(theme, overlay)) } catch { /* an older app shell - leave the bar as it is */ }
  if (overlay && verdict === null && !checking && typeof setTimeout === 'function') {
    checking = true
    setTimeout(() => {
      const ok = topInsetPx() > 0
      try { localStorage.setItem(OVERLAY_KEY, ok ? 'yes' : 'no') } catch { /* private mode: checked again next open */ }
      if (!ok) { try { set.call(w.median!.statusbar, statusBarFor(currentTheme, false)) } catch { /* */ } }
    }, CHECK_AFTER_MS)
  }
  return true
}

let currentTheme: 'light' | 'dark' = 'light'

/**
 * Matches Median's status bar to the app's theme. The bridge can load after
 * this runs (Median calls `median_library_ready` once it has), so the latest
 * request is kept and applied then.
 */
export function syncMedianStatusBar(theme: 'light' | 'dark'): void {
  if (typeof window === 'undefined') return
  const w = window as MedianWindow
  currentTheme = theme
  if (apply(w, theme)) return
  pending = theme
  if (hooked) return
  hooked = true
  const before = w.median_library_ready
  w.median_library_ready = () => {
    try { before?.() } catch { /* someone else's handler */ }
    if (pending) apply(w, pending)
  }
}
