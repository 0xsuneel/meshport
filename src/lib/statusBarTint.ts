// ── Status bar tint ─────────────────────────────────────────────────────────
// The browser's status bar (and the installed web app's) follows
// <meta name="theme-color">, which otherwise stays at the page's own colour.
// A screen that is all colour at its top - the success flash, the success
// page's band, Home's teal band - would otherwise sit under a white / black
// strip (19 Nov 2026). While such a screen is up it tints the bar to its own
// top colour; when it goes, the page's colour comes back. Inside the Median
// app shell the native bar is set through its bridge instead (lib/median.ts).
//
// No flicker (27 Nov): the tint goes on before the screen's first paint
// (layout effect), and when a screen leaves its tint stays until the page
// slide has finished, so the bar never changes colour while the old screen
// is still on view. The theme (light / dark) goes through refreshStatusBar
// too, so it never writes over a tint that is up.
import { useLayoutEffect } from 'react'
import { setMedianStatusBarColor } from './median'

type Entry = { hex: string }
const stack: Entry[] = []

const pageColor = () => document.documentElement.getAttribute('data-theme') === 'dark' ? '#000000' : '#F5F4F0'

/** Any CSS colour (vars, color-mix…) as #rrggbb, read back from a painted pixel. */
function toHex(css: string): string | null {
  if (/^#[0-9a-f]{6}$/i.test(css)) return css.toLowerCase()
  try {
    const probe = document.createElement('span')
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none'
    probe.style.color = css
    document.body.appendChild(probe)
    const resolved = getComputedStyle(probe).color
    probe.remove()
    const c = document.createElement('canvas'); c.width = c.height = 1
    const ctx = c.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = resolved
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
    return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
  } catch { return null }
}

// Opening straight onto Home, boot.js has already put the bar in Home's teal:
// it is held as a tint until Home takes over (or 4 s, if Home never shows -
// e.g. the lock screen), so nothing paints the page colour in between.
const BOOT_TEAL = new Set(['#12665f', '#0e4f49'])
let bootEntry: Entry | null = null
if (typeof document !== 'undefined') {
  const c = document.getElementById('mp-theme-color')?.getAttribute('content')?.toLowerCase()
  if (c && BOOT_TEAL.has(c)) {
    bootEntry = { hex: c }
    stack.push(bootEntry)
    setTimeout(releaseBootTint, 4000)
  }
}
function releaseBootTint() {
  if (!bootEntry) return
  const i = stack.indexOf(bootEntry)
  if (i >= 0) stack.splice(i, 1)
  bootEntry = null
  refreshStatusBar()
}

let shown: string | null | undefined
/** Puts the bar in the top tint, or the page's colour when none is up. Safe to call any time. */
export function refreshStatusBar(force = false) {
  if (typeof document === 'undefined') return
  const top = stack.length ? stack[stack.length - 1].hex : null
  const color = top ?? pageColor()
  const meta = document.getElementById('mp-theme-color')
  if (meta && meta.getAttribute('content') !== color) meta.setAttribute('content', color)
  if (force || shown !== top) { shown = top; setMedianStatusBarColor(top) }
}

/**
 * Tints the status bar to `css` while the calling screen is mounted (null:
 * leave it). `holdMs`: how long the tint stays after the screen goes - a
 * whole page (Home) keeps it through the page slide taking it away.
 */
export function useStatusBarTint(css: string | null, holdMs: number | (() => number) = 0) {
  useLayoutEffect(() => {
    if (!css || typeof document === 'undefined') return
    const hex = toHex(css)
    if (!hex) return
    const entry: Entry = { hex }
    stack.push(entry)
    // A real tint is up now: the startup one has done its job.
    if (bootEntry) { const i = stack.indexOf(bootEntry); if (i >= 0) stack.splice(i, 1); bootEntry = null }
    refreshStatusBar()
    return () => {
      const drop = () => {
        const i = stack.indexOf(entry)
        if (i >= 0) stack.splice(i, 1)
        refreshStatusBar()
      }
      const ms = typeof holdMs === 'function' ? holdMs() : holdMs
      if (ms > 0) setTimeout(drop, ms); else drop()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- holdMs is read when the screen goes, not a reason to re-tint
  }, [css])
}
