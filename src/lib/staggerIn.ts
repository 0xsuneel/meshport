// ── Staggered reveal for a page's list / sections (19 Nov 2026) ─────────────
// The same reveal as the history card: each part fades and rises in turn as
// the page opens - Activity's rows, Rewards' sections, the chats, the Hub's
// and Swap's history. Only what's on screen moves (at most 14 parts, 60 ms
// apart, 0.42 s each), once per page open - never on a refresh, a new row or
// scroll-loading. Uses the separate `translate` property (a row's own
// transform is untouched) and Web Animations with fill "backwards", so
// nothing waits on React. Off with reduced motion.
import { useLayoutEffect, useRef, type RefObject } from 'react'

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'

/** Reveals `container`'s parts (its children, or the `selector` matches) in turn. */
export function staggerIn(container: HTMLElement, selector?: string): void {
  if (typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  const parts = selector ? [...container.querySelectorAll<HTMLElement>(selector)] : [...container.children] as HTMLElement[]
  const bottom = window.innerHeight
  let i = 0
  for (const el of parts) {
    if (i >= 14) break
    if (!(el instanceof HTMLElement) || typeof el.animate !== 'function') continue
    const r = el.getBoundingClientRect()
    if (r.height === 0) continue
    if (r.top > bottom) break
    el.animate(
      [{ opacity: 0, translate: '0 14px' }, { opacity: 1, translate: '0 0' }],
      { duration: 420, delay: i * 60, easing: EASE, fill: 'backwards' },
    )
    i++
  }
}

/** Runs staggerIn on `ref` once, the first time `ready` is true (per mount). */
export function useStaggerIn(ref: RefObject<HTMLElement | null>, ready: boolean, selector?: string): void {
  const done = useRef(false)
  useLayoutEffect(() => {
    if (done.current || !ready || !ref.current) return
    done.current = true
    staggerIn(ref.current, selector)
  }, [ready, ref, selector])
}
