import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { opensKeyboard } from '@/hooks/useKeyboardOpen'
import { keyboardInset, virtualKeyboard, holdKeyboardOverlay } from '@/lib/keyboardOverlay'

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
  const top = Math.max(0, Math.round(vv.offsetTop))
  // Android with the keyboard drawn over the app (lib/keyboardOverlay): no
  // viewport shrinks, so take the keyboard's own height off.
  const inset = keyboardInset()
  if (inset > 0) return { top, height: Math.round(vv.height - inset) }
  // iOS 26: after the keyboard closes, visualViewport can stay ~24px shorter
  // than the screen for good (Apple FB19889436 / WebKit 297779) - the frame
  // then stopped short of the bottom. With no field focused and nothing
  // panned, a gap that small is that bug, not browser chrome (iOS toolbars
  // are taller), so the frame takes the whole screen.
  const gap = window.innerHeight - vv.height
  if (top === 0 && gap > 1 && gap <= 30 && !opensKeyboard(document.activeElement)) return { top: 0, height: window.innerHeight }
  return { top, height: Math.round(vv.height) }
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
    // in the same frame as the pan - no one-frame jump. Written only when
    // it changed: these events fire on every scroll, and a height write
    // re-lays-out the whole app.
    let lastTop = -1, lastHeight = '', lastPx = -1
    // Keyboard up = a text field has focus AND the visible area has actually
    // shrunk from its full height (at this width). Marked on the frame as
    // data-kb so CSS hides the bottom nav in the very frame the keyboard
    // takes the space - never earlier (on focus) or later (a re-render).
    // It clears only when the space comes back, so the nav doesn't pop up
    // above a keyboard that is still closing.
    let fullH = 0, fullW = 0, kb = false
    const apply = () => {
      const { top, height } = visibleFrame()
      if (window.innerWidth !== fullW) { fullW = window.innerWidth; fullH = 0 }
      fullH = Math.max(fullH, height)
      const shrunk = height < fullH - 120
      const nextKb = kb ? shrunk : shrunk && opensKeyboard(document.activeElement)
      if (nextKb !== kb) { kb = nextKb; if (kb) el.dataset.kb = ''; else delete el.dataset.kb }
      // Visible area = the whole layout viewport (no keyboard, or Android,
      // whose keyboard shrinks the layout viewport itself): plain 100%, so
      // the browser resizes the frame in the same layout pass as the
      // keyboard - a pixel value set from this event lands a frame or more
      // late, and the bottom of the screen (the chat box) was cut off and
      // then jumped back.
      // Compared with the LAYOUT viewport (what 100% of this fixed frame is),
      // never window.innerHeight: iPhone shrinks innerHeight with the
      // keyboard while the layout viewport stays full, so "matches
      // innerHeight" gave the frame 100% = full height with the keyboard up,
      // and Pay's message box / Transfer's routes sat under the keys.
      const layoutH = document.documentElement.clientHeight
      const h = top === 0 && Math.abs(height - layoutH) <= 1 ? '100%' : `${height}px`
      if (top !== lastTop) { el.style.top = `${top}px`; lastTop = top }
      if (h !== lastHeight) { el.style.height = h; lastHeight = h }
      // The visible height for sheets inside (ActionSheet etc.): dvh units
      // don't shrink for a keyboard on iPhone, nor for one drawn over the
      // app on Android.
      if (height !== lastPx) { el.style.setProperty('--frame-h', `${height}px`); lastPx = height }
      // The document's own scroll is corrected separately (queueDocFix).
      queueDocFix()
    }
    // The document itself never scrolls in this app: undo a sideways shift,
    // and the scroll iOS can leave behind once the keyboard closes. Only once
    // things are still - no finger down and no scroll event for 500 ms - and
    // instantly: when a list reaches its end iPhone hands the swipe to the
    // document (the rubber-band). Correcting that mid-gesture or mid-bounce
    // (animated, too - html has scroll-behavior: smooth) fought the finger:
    // the list stuck at the bottom or half-way, and the next tap (often Back)
    // only stopped that scroll.
    let touching = false, docFixTimer = 0
    const fixDocScroll = () => {
      if (touching) return
      const { top } = visibleFrame()
      if (window.scrollX || (top === 0 && window.scrollY)) {
        window.scrollTo({ left: 0, top: top === 0 ? 0 : window.scrollY, behavior: 'instant' as ScrollBehavior })
      }
    }
    function queueDocFix() {
      clearTimeout(docFixTimer)
      docFixTimer = window.setTimeout(fixDocScroll, 500)
    }
    const onTouchStart = () => { touching = true; clearTimeout(docFixTimer) }
    const onTouchEnd = (e: TouchEvent) => { if (e.touches.length === 0) { touching = false; queueDocFix() } }
    // Keyboard opened (or another field focused while it's up): once the
    // frame has its new size, bring the field into view.
    let lastH = visibleFrame().height
    let raf = 0
    const settle = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(keepFocusedInView) }
    // Measured again once things settle: Android can fire the resize while
    // the viewport still reports the keyboard-up size, and no event follows -
    // the frame then stayed short after the keyboard was hidden, with an
    // empty band under the chat box. Re-measuring a frame later and after
    // the keyboard's own animation fixes it; apply() only writes on change.
    let recheckRaf = 0, recheckTimer = 0
    const recheck = () => {
      cancelAnimationFrame(recheckRaf); clearTimeout(recheckTimer)
      recheckRaf = requestAnimationFrame(apply)
      recheckTimer = window.setTimeout(apply, 350)
    }
    const schedule = () => {
      apply()
      recheck()
      const h = visibleFrame().height
      if (h < lastH - 80) settle()
      lastH = h
    }
    // Layout viewport, not innerHeight (which iPhone shrinks with the keyboard).
    const onFocus = () => { apply(); if (visibleFrame().height < document.documentElement.clientHeight - 80) settle() }
    document.addEventListener('touchstart', onTouchStart, { passive: true, capture: true })
    document.addEventListener('touchend', onTouchEnd, { passive: true, capture: true })
    document.addEventListener('touchcancel', onTouchEnd, { passive: true, capture: true })
    // The keyboard can be hidden (back gesture / hide key) without the field
    // losing focus, and closed by a blur: either way, look again.
    const onFocusOut = () => recheck()
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('focusin', onFocus)
    apply()
    vv?.addEventListener('resize', schedule)
    vv?.addEventListener('scroll', schedule)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule)
    // Android keyboard drawn over the app (only while this frame is up):
    // no viewport event fires, this does.
    const releaseOverlay = holdKeyboardOverlay()
    const vk = virtualKeyboard()
    vk?.addEventListener('geometrychange', schedule)
    return () => {
      vk?.removeEventListener('geometrychange', schedule)
      releaseOverlay()
      cancelAnimationFrame(raf)
      cancelAnimationFrame(recheckRaf); clearTimeout(recheckTimer); clearTimeout(docFixTimer)
      document.removeEventListener('touchstart', onTouchStart, { capture: true })
      document.removeEventListener('touchend', onTouchEnd, { capture: true })
      document.removeEventListener('touchcancel', onTouchEnd, { capture: true })
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('focusin', onFocus)
      vv?.removeEventListener('resize', schedule)
      vv?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule)
    }
  }, [ref, enabled])
}

/**
 * Nothing in the app scrolls sideways on purpose except swipeable rows
 * (overflow-x: auto). iPhone, though, scrolls even overflow:hidden boxes to
 * bring a focused field into view - e.g. a field focused while its page is
 * still sliding in from the right - and leaves the whole screen shifted
 * half off the side. Puts any such sideways scroll straight back, and keeps
 * every box that is never meant to scroll at the top: the frame itself,
 * anything marked data-no-scroll, and any overflow:hidden box. When the
 * keyboard opens, iPhone scrolls the page's overflow:hidden wrappers up to
 * reach the focused field, which pushed the header off the screen and left
 * an empty band above the keys (Receive's request form, the chat box).
 */
export function useFrameScrollGuard(ref: RefObject<HTMLElement | null>, enabled = true) {
  useEffect(() => {
    const frame = ref.current
    if (!enabled || !frame) return
    // This runs on every scroll event of every list, and reading computed
    // style there forces a style pass each time. A box found free to scroll
    // both ways (the lists people actually scroll) is remembered; a locked
    // one is read again each time, since a box can unlock later (a sheet
    // that locked the page closes) and must never be snapped back after.
    // Kept per direction: a page list scrolls up and down freely while
    // staying locked sideways.
    const freeX = new WeakSet<HTMLElement>(), freeY = new WeakSet<HTMLElement>()
    const lockedX = (el: HTMLElement) => {
      if (freeX.has(el)) return false
      const ox = getComputedStyle(el).overflowX
      const locked = ox === 'hidden' || ox === 'clip'
      if (!locked) freeX.add(el)
      return locked
    }
    const lockedY = (el: HTMLElement) => {
      if (freeY.has(el)) return false
      const oy = getComputedStyle(el).overflowY
      const locked = el === frame || el.hasAttribute('data-no-scroll') || oy === 'hidden' || oy === 'clip'
      if (!locked) freeY.add(el)
      return locked
    }
    const onScroll = (e: Event) => {
      const el = e.target
      if (!(el instanceof HTMLElement) || (!el.scrollLeft && !el.scrollTop) || el.closest('.mp-page-snapshot')) return
      if (el.scrollLeft && lockedX(el)) el.scrollLeft = 0
      if (el.scrollTop && lockedY(el)) el.scrollTop = 0
    }
    frame.addEventListener('scroll', onScroll, true)
    return () => frame.removeEventListener('scroll', onScroll, true)
  }, [ref, enabled])
}
