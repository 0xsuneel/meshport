// ── Median (median.co) app shell ────────────────────────────────────────────
// The iOS / Android apps built with Median show this site in the phone's own
// web view, under a native status bar. That bar ignores the page's
// <meta name="theme-color"> (which the browser and the installed web app
// follow), so by default it stays the colour set in Median's dashboard
// whatever theme MeshPort is in. Median's JavaScript bridge (`window.median`,
// injected only inside its apps) lets the page set it: the same colour as the
// page, with dark or light icons to match. Outside a Median app none of this
// runs.

export type StatusBarOptions = { style: 'light' | 'dark'; color: string; overlay: boolean }

type MedianBridge = { statusbar?: { set?: (o: StatusBarOptions) => void } }
type MedianWindow = Window & { median?: MedianBridge; median_library_ready?: () => void }

/** Status bar for a page in this theme: the page's background, readable icons. */
export function statusBarFor(theme: 'light' | 'dark'): StatusBarOptions {
  return theme === 'dark'
    ? { style: 'light', color: '000000', overlay: false } // light icons on black
    : { style: 'dark', color: 'F5F4F0', overlay: false }  // dark icons on the warm page
}

let pending: StatusBarOptions | null = null
let hooked = false

function apply(w: MedianWindow, o: StatusBarOptions): boolean {
  const set = w.median?.statusbar?.set
  if (typeof set !== 'function') return false
  try { set.call(w.median!.statusbar, o) } catch { /* an older app shell - leave the bar as it is */ }
  return true
}

/**
 * Matches Median's status bar to the app's theme. The bridge can load after
 * this runs (Median calls `median_library_ready` once it has), so the latest
 * request is kept and applied then.
 */
export function syncMedianStatusBar(theme: 'light' | 'dark'): void {
  if (typeof window === 'undefined') return
  const w = window as MedianWindow
  const o = statusBarFor(theme)
  if (apply(w, o)) return
  pending = o
  if (hooked) return
  hooked = true
  const before = w.median_library_ready
  w.median_library_ready = () => {
    try { before?.() } catch { /* someone else's handler */ }
    if (pending) apply(w, pending)
  }
}
