// wallet-frame/src/visibleGate.ts
//
// "Was this page really in view when the person tapped?" - the clickjacking
// check for pages that are embedded cross-origin (reveal.html, passkey.html).
//
// Built on IntersectionObserver v2 (`isVisible`), which the browser sets false
// when something is drawn over the page, or it is partly covered, faded or
// filtered. v2 may report false for a page that IS visible (the spec allows
// false negatives), so a single "not visible" reading never wipes anything
// here: a tap simply doesn't count until the page has been in view for
// MIN_VISIBLE_MS in a row. A short blip right after such a stretch is let
// through, so a real tap isn't lost to a flicker.
//
// Where the browser has no v2 the gate lets input through (nothing to ask).

/** A tap counts only after the page has been in view this long, in a row. */
export const MIN_VISIBLE_MS = 400
/** A "not visible" reading shorter than this, after a settled stretch, is a blip. */
export const BLIP_MS = 700

type V2Entry = IntersectionObserverEntry & { isVisible?: boolean }
type V2Ctor = new (cb: (entries: V2Entry[]) => void, o: object) => IntersectionObserver

export interface VisibleGate {
  /** Whether a tap right now should count. */
  ok(): boolean
  /** Stops watching. */
  stop(): void
}

export interface GateEnv {
  IO?: V2Ctor
  now?: () => number
  target?: Element
}

export function watchVisible(env: GateEnv = {}): VisibleGate {
  const IO = env.IO ?? (typeof window !== 'undefined'
    ? (window.IntersectionObserver as unknown as V2Ctor | undefined) : undefined)
  const now = env.now ?? (() => performance.now())
  const accept: VisibleGate = { ok: () => true, stop: () => {} }
  if (!IO) return accept

  let known = false // has the browser given a v2 reading yet
  let visible = false
  let since = 0 // when the current visible stretch began
  let settledAt = -Infinity // last moment the page was visible after a settled stretch

  let io: IntersectionObserver
  try {
    io = new IO(entries => {
      const last = entries[entries.length - 1]
      if (!last || last.isVisible === undefined) return // v1 only: nothing to tell
      const t = now()
      known = true
      if (last.isVisible) {
        if (!visible) since = t
        visible = true
      } else {
        // Leaving view: remember it if the stretch had settled.
        if (visible && t - since >= MIN_VISIBLE_MS) settledAt = t
        visible = false
      }
    }, { threshold: [0.98, 1], trackVisibility: true, delay: 100 })
    if (!('trackVisibility' in io)) { io.disconnect(); return accept } // not v2
    io.observe(env.target ?? document.body)
  } catch { return accept /* not supported: keep accepting */ }

  return {
    ok() {
      if (!known) return false // v2 present but silent so far: not proven in view
      const t = now()
      if (visible) return t - since >= MIN_VISIBLE_MS
      return t - settledAt <= BLIP_MS
    },
    stop() { try { io.disconnect() } catch { /* */ } },
  }
}
