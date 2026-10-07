import { useLayoutEffect } from 'react'

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

export function usePopupOpen() {
  useLayoutEffect(() => {
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
