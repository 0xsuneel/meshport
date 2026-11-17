// Content fade-up after a skeleton - the second half of the "soft glow"
// loading style (17 Nov): when a screen's real content replaces its loading
// placeholders, it rises into place section by section instead of popping in.
//
// One watcher for the whole app instead of a wrapper on each of the 30+
// screens: a MutationObserver sees a skeleton leave the page (an .mp-skel
// block or an aria-busy loading group, or something containing one) and, in
// the same update, new elements added to the same parent - those are what
// replaced it, and they fade up, a little later each. A single added
// container has its own children staggered instead (a list's rows, a page's
// sections).
//
// Only content that replaces a skeleton animates - a screen opened from its
// saved data (no skeleton) appears at once, as before. It animates opacity and
// the separate `translate` property, which adds to an element's own transform
// (framer-motion's) rather than replacing it; anything already animating
// (Insights' and Activity's own fade) is left alone. Off with reduced motion.

const SKELETON = '.mp-skel, [aria-busy="true"]'
const MAX_STAGGER = 8
const STEP_MS = 60
const KEYFRAMES: Keyframe[] = [
  { opacity: 0, translate: '0 6px' },
  { opacity: 1, translate: '0 0' },
]

const isSkeleton = (n: Node): boolean =>
  n instanceof Element && (n.matches(SKELETON) || !!n.querySelector(SKELETON))

function rise(els: Element[]) {
  els.slice(0, MAX_STAGGER).forEach((el, i) => {
    if (!(el instanceof HTMLElement) || el.getAnimations().length) return
    el.animate(KEYFRAMES, { duration: 450, delay: i * STEP_MS, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' })
  })
}

let started = false
/** Starts the watcher once for the whole app (main.tsx). */
export function startContentReveal(): void {
  if (started || typeof window === 'undefined' || typeof MutationObserver === 'undefined') return
  started = true
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  const observer = new MutationObserver(records => {
    if (reduced?.matches) return
    // Parents a skeleton just left (cheap first pass: only removals).
    let cleared: Set<Node> | null = null
    for (const r of records) {
      if (!r.removedNodes.length) continue
      for (const n of r.removedNodes) {
        if (isSkeleton(n)) { (cleared ??= new Set()).add(r.target); break }
      }
    }
    if (!cleared) return
    for (const parent of cleared) {
      const added: Element[] = []
      for (const r of records) {
        if (r.target !== parent) continue
        for (const n of r.addedNodes) if (n instanceof Element && n.isConnected && !isSkeleton(n)) added.push(n)
      }
      if (!added.length) continue
      // One container (a list, a page body): its own sections, one by one.
      const kids = added.length === 1 ? [...added[0].children].filter(c => !isSkeleton(c)) : []
      rise(kids.length > 1 ? kids : added)
    }
  })
  const begin = () => observer.observe(document.body, { childList: true, subtree: true })
  if (document.body) begin()
  else document.addEventListener('DOMContentLoaded', begin, { once: true })
}
