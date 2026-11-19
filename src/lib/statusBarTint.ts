// ── Status bar tint ─────────────────────────────────────────────────────────
// The browser's status bar (and the installed web app's) follows
// <meta name="theme-color">, which themeStore keeps at the page's own colour.
// A screen that is all colour at its top - the success flash, the success
// page's band - would otherwise sit under a white / black strip (19 Nov 2026).
// While such a screen is up it tints the bar to its own top colour; when it
// goes, the page's colour comes back. Inside the Median app shell the native
// bar is set through its bridge instead (lib/median.ts).
import { useEffect } from 'react'
import { setMedianStatusBarColor } from './median'

const stack: string[] = []

const pageColor = () => document.documentElement.getAttribute('data-theme') === 'dark' ? '#000000' : '#F5F4F0'

/** Any CSS colour (vars, color-mix…) as #rrggbb, read back from a painted pixel. */
function toHex(css: string): string | null {
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

function apply() {
  const top = stack[stack.length - 1]
  document.getElementById('mp-theme-color')?.setAttribute('content', top ?? pageColor())
  setMedianStatusBarColor(top ?? null)
}

/** Tints the status bar to `css` while the calling screen is mounted (null: leave it). */
export function useStatusBarTint(css: string | null) {
  useEffect(() => {
    if (!css || typeof document === 'undefined') return
    const hex = toHex(css)
    if (!hex) return
    stack.push(hex)
    apply()
    return () => {
      const i = stack.lastIndexOf(hex)
      if (i >= 0) stack.splice(i, 1)
      apply()
    }
  }, [css])
}
