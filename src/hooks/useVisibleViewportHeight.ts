import { useEffect, useState } from 'react'

// The real, currently-visible viewport height in pixels — NOT the CSS
// `100vh`/`100dvh` layout viewport. On iOS (Safari and Chrome, both
// WKWebView), the browser's own address bar / bottom tab bar are drawn as
// a native overlay ON TOP of the page, not carved out of it — the layout
// viewport (and therefore `vh`/`dvh`) stays the same size whether that
// chrome is showing or not. A bottom sheet sized/positioned against that
// taller, constant layout viewport can end up with its lowest content
// (e.g. a trailing "Close" button) rendered UNDER that browser chrome,
// which is the "why is browser navigation showing over my sheet" symptom
// reported on iPhone (Chrome for iOS) — the sheet was never behind the
// bar, the bar is simply drawn on top of wherever the sheet's real bottom
// edge landed.
//
// `window.visualViewport.height` tracks the actual visible area instead —
// it shrinks exactly when that chrome (or the on-screen keyboard) is
// occupying part of the screen — same API ChatPage.tsx already uses to
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
