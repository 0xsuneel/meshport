// ── Run when the app is idle ────────────────────────────────────────────────
// requestIdleCallback where the browser has it (Chrome, Android). Safari and
// iOS's web view (the iPhone app) don't, and a plain timer there could start
// loading a page's code - or the Circle SDK - while the person is scrolling or
// a page is sliding in. The fallback waits until there has been no touch,
// scroll or key for QUIET_MS (a tap's page slide is over well before), and
// runs anyway once `timeout` has passed.

const QUIET_MS = 600
const INPUT_EVENTS = ['pointerdown', 'touchstart', 'touchmove', 'wheel', 'scroll', 'keydown'] as const

let lastInput = 0
let listening = false
function listen(): void {
  if (listening || typeof window === 'undefined') return
  listening = true
  const mark = () => { lastInput = Date.now() }
  for (const e of INPUT_EVENTS) window.addEventListener(e, mark, { capture: true, passive: true })
}

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number
  cancelIdleCallback?: (id: number) => void
}

/** Runs `cb` when idle (at the latest after `timeout` ms). Returns a cancel function. */
export function whenIdle(cb: () => void, { timeout = 3000 }: { timeout?: number } = {}): () => void {
  if (typeof window === 'undefined') return () => {}
  const w = window as IdleWindow
  if (typeof w.requestIdleCallback === 'function') {
    const id = w.requestIdleCallback(cb, { timeout })
    return () => w.cancelIdleCallback?.(id)
  }
  listen()
  const start = Date.now()
  let t: number | undefined
  let done = false
  const check = () => {
    if (done) return
    const now = Date.now()
    const quietFor = now - lastInput
    if (now - start >= timeout || quietFor >= QUIET_MS) { done = true; cb(); return }
    // Look again once the quiet period could be over.
    const wait = Math.max(QUIET_MS - quietFor, 50)
    t = window.setTimeout(check, Math.min(wait, timeout - (now - start)))
  }
  t = window.setTimeout(check, Math.min(50, timeout))
  return () => { done = true; if (t !== undefined) clearTimeout(t) }
}

/** For tests: forget the last input. */
export function _resetIdleForTests(): void { lastInput = 0 }
