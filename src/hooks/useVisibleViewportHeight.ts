import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { opensKeyboard } from '@/hooks/useKeyboardOpen'

// The real, currently-visible viewport height in pixels - NOT the CSS
// `100vh`/`100dvh` layout viewport. On iOS (Safari and Chrome, both
// WKWebView), the browser's own address bar / bottom tab bar are drawn as
// a native overlay ON TOP of the page, not carved out of it - the layout
// viewport (and therefore `vh`/`dvh`) stays the same size whether that
// chrome is showing or not. A bottom sheet sized/positioned against that
// taller, constant layout viewport can end up with its lowest content
// (e.g. a trailing "Close" button) rendered UNDER that browser chrome,
// which is the "why is browser navigation showing over my sheet" symptom
// reported on iPhone (Chrome for iOS) - the sheet was never behind the
// bar, the bar is simply drawn on top of wherever the sheet's real bottom
// edge landed.
//
// `window.visualViewport.height` tracks the actual visible area instead -
// it shrinks exactly when that chrome (or the on-screen keyboard) is
// occupying part of the screen - same API ChatPage.tsx already uses to
// solve the analogous keyboard-overlay problem. Falls back to
// window.innerHeight on platforms without VisualViewport support.
export function useVisibleViewportHeight(): number | null {
  const [height, setHeight] = useState<number | null>(() => {
    if (typeof window === 'undefined') return null
    return window.visualViewport ? window.visualViewport.height : window.innerHeight
  })

  useEffect(() => {
    const vv = window.visualViewport
    const update = () => setHeight(vv ? vv.height : window.innerHeight)
    update()
    vv?.addEventListener('resize', update)
    window.addEventListener('resize', update)
    return () => {
      vv?.removeEventListener('resize', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  return height
}

// Where the visible area is right now, in layout-viewport pixels.
//
// iPhone (Safari and Chrome): the keyboard does NOT shrink the layout
// viewport. The visible area shrinks (visualViewport.height) AND is
// panned down (visualViewport.offsetTop > 0) to bring the focused field
// above the keys - while position:fixed stays tied to the unmoved layout
// viewport. A fixed frame of the right HEIGHT but at top:0 then sits
// partly above the screen: its header is scrolled off the top and an
// empty band the size of the pan shows under it - the "chat box jumps to
// the top with a blank space below" / "sheet pulled upward" bug.
// Following offsetTop too keeps the frame exactly on the visible area.
// Android (resizes-content) never pans: offsetTop stays 0 there.
export function visibleFrame(): { top: number; height: number } {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  if (!vv) return { top: 0, height: typeof window !== 'undefined' ? window.innerHeight : 0 }
  // Pinch-zoomed: the visible area is a magnified part of the page - keep
  // the frame on the whole layout viewport instead of chasing the zoom.
  if (Math.abs(vv.scale - 1) > 0.01) return { top: 0, height: window.innerHeight }
  return { top: Math.max(0, Math.round(vv.offsetTop)), height: Math.round(vv.height) }
}

/**
 * The focused field fully inside the visible area: scrolls the scroll
 * boxes around it (never the page itself). Needed once the frame has
 * shrunk to the space above the keyboard - a field low on a long form
 * would otherwise end up under the keys.
 */
function keepFocusedInView() {
  const el = document.activeElement
  if (!(el instanceof HTMLElement) || !opensKeyboard(el)) return
  const { top, height } = visibleFrame()
  const r = el.getBoundingClientRect()
  const M = 12
  // > 0: below the visible area by that much; < 0: above it.
  let off = r.bottom + M > top + height ? Math.min(r.bottom + M - (top + height), r.top - (top + M)) : (r.top < top + M ? r.top - (top + M) : 0)
  for (let p = el.parentElement; p && off !== 0; p = p.parentElement) {
    if (!/(auto|scroll)/.test(getComputedStyle(p).overflowY) || p.scrollHeight <= p.clientHeight) continue
    const before = p.scrollTop
    p.scrollTop = before + off
    off -= p.scrollTop - before
  }
}

/**
 * Keeps a position:fixed element exactly over the visible area (top +
 * height), writing straight to its style - no re-render on every pan frame.
 * Also undoes the page scroll iOS sometimes leaves behind after the
 * keyboard closes (the app never scrolls the document itself).
 */
export function useVisibleFrame(ref: RefObject<HTMLElement | null>, enabled = true) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!enabled || !el) return
    const vv = window.visualViewport
    // Applied right in the event (not a frame later), so the frame moves
    // in the same frame as the pan - no one-frame jump.
    const apply = () => {
      const { top, height } = visibleFrame()
      el.style.top = `${top}px`
      el.style.height = `${height}px`
      // The document itself never scrolls in this app: undo a sideways
      // shift, and the scroll iOS can leave behind once the keyboard closes.
      if (window.scrollX) window.scrollTo(0, window.scrollY)
      if (top === 0 && window.scrollY) window.scrollTo(0, 0)
    }
    // Keyboard opened (or another field focused while it's up): once the
    // frame has its new size, bring the field into view.
    let lastH = visibleFrame().height
    let raf = 0
    const settle = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(keepFocusedInView) }
    const schedule = () => {
      apply()
      const h = visibleFrame().height
      if (h < lastH - 80) settle()
      lastH = h
    }
    const onFocus = () => { if (visibleFrame().height < window.innerHeight - 80) settle() }
    document.addEventListener('focusin', onFocus)
    apply()
    vv?.addEventListener('resize', schedule)
    vv?.addEventListener('scroll', schedule)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('focusin', onFocus)
      vv?.removeEventListener('resize', schedule)
      vv?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule)
    }
  }, [ref, enabled])
}
