import { useLayoutEffect, useSyncExternalStore } from 'react'

// While any popup is mounted (centred popups, sheets, history receipts, the
// payment success flash), <html> carries `popup-open`, which switches off
// every backdrop-filter on the page underneath (see `html.popup-open` in
// index.css). Android Chrome re-runs each of those blurs on every frame a
// popup fades or springs in over them, which shows up as the screen blinking.
//
// A layout effect, not a plain effect: the class has to be on <html> before
// the popup's first frame is painted, otherwise the first frames of its
// entrance still run over the live blurs and the page visibly jumps when
// they drop a moment later.
//
// A counter keeps the class on while popups are stacked.
let openPopups = 0

// Separately, on every device: how many popups / sheets / Hub pages are open,
// for things that must step out of their way (useAnyPopupOpen) - the
// notifications card sat over the Review button of Transfer's panel.
let anyOpen = 0
const listeners = new Set<() => void>()
const notify = () => { for (const l of [...listeners]) l() }

// Phones: index.css already switches every page blur off for good (the
// `(hover: none) and (pointer: coarse)` rule), so the class would change
// nothing - and toggling it restyles the whole page (`#root *`) as each popup
// opens and closes, a dropped frame right when it starts and ends. Skipped.
const BLURS_ALWAYS_OFF = typeof window !== 'undefined' && !!window.matchMedia?.('(hover: none) and (pointer: coarse)').matches

export function usePopupOpen() {
  useLayoutEffect(() => {
    anyOpen += 1
    notify()
    return () => { anyOpen = Math.max(0, anyOpen - 1); notify() }
  }, [])
  useLayoutEffect(() => {
    if (BLURS_ALWAYS_OFF) return
    openPopups += 1
    document.documentElement.classList.add('popup-open')
    return () => {
      openPopups = Math.max(0, openPopups - 1)
      if (openPopups === 0) document.documentElement.classList.remove('popup-open')
    }
  }, [])
}

/** Renders nothing; holds `popup-open` while mounted (for overlays that
 *  aren't built from DesktopDialogFrame / SuccessFlash / receipts). */
export function PopupOpen() {
  usePopupOpen()
  return null
}

/** True while any popup, sheet or Hub page (anything using usePopupOpen) is open. */
export function useAnyPopupOpen(): boolean {
  return useSyncExternalStore(
    l => { listeners.add(l); return () => { listeners.delete(l) } },
    () => anyOpen > 0,
    () => false,
  )
}
