import { useEffect, useState } from 'react'

function computeIsStandalone() {
  if (typeof window === 'undefined') return false
  // Two different signals for the same thing, because no single one
  // covers every platform: the standard `display-mode` media query
  // (Android/desktop installed PWAs), and Safari's older iOS-specific
  // `navigator.standalone` flag (iOS home-screen installs predate the
  // media query support). `as any` because `standalone` isn't in the
  // default lib.dom.d.ts Navigator type.
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone
  return window.matchMedia?.('(display-mode: standalone)').matches || iosStandalone === true
}

// Whether the app is running installed/added-to-home-screen (no browser
// chrome at all) vs. a regular browser tab (address bar + toolbar always
// present). Only really relevant on iOS: `window.visualViewport` reliably
// tracks the on-screen keyboard there, but is known to NOT reliably track
// the browser's own persistent toolbar the way it does the keyboard — so
// bottom sheets can't fully rely on measuring it away (see
// useVisibleViewportHeight). This flag lets sheets add a fixed safety
// buffer ONLY when that un-measurable browser chrome can actually be
// present, leaving installed-PWA users (genuinely chrome-free) untouched.
export function useIsStandalone(): boolean {
  const [isStandalone, setIsStandalone] = useState(computeIsStandalone)
  useEffect(() => {
    const mql = window.matchMedia?.('(display-mode: standalone)')
    const update = () => setIsStandalone(computeIsStandalone())
    update()
    mql?.addEventListener('change', update)
    return () => mql?.removeEventListener('change', update)
  }, [])
  return isStandalone
}
