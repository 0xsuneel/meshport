// ── Back gestures the browser animates itself ──────────────────────────────
// On iPhone (Safari, and the Median app's web view) swiping in from the left
// edge goes back with iOS's own slide - the old page is dragged off under the
// finger. Chrome on Android does the same with its predictive back gesture.
// The app then got a normal history "back" and played its own back slide on
// top: the same page slid in twice. Browsers say when they have already shown
// the transition (PopStateEvent.hasUAVisualTransition, Safari 18 / Chrome
// 123); the page transition skips its own then.

const FRESH_MS = 1000
let last = { at: 0, ua: false }

if (typeof window !== 'undefined') {
  // Capture, so this is noted before the router reacts to the same event.
  window.addEventListener('popstate', e => {
    last = { at: Date.now(), ua: (e as PopStateEvent & { hasUAVisualTransition?: boolean }).hasUAVisualTransition === true }
  }, { capture: true })
}

/** Whether the browser itself animated the back navigation that just happened. */
export function browserAnimatedBack(now = Date.now()): boolean {
  return last.ua && now - last.at < FRESH_MS
}

/** For tests. */
export function _notePopForTests(ua: boolean, at = Date.now()): void { last = { at, ua } }
