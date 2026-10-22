/**
 * PushLayer — the slide-over page under every Business screen and the
 * Manage orders / money panel: a dim veil over what's beneath and a panel
 * that slides the full width in from the right, shifts 28% left while
 * another screen covers it, and slides off to the right on back.
 *
 * Runs on the browser's own animation engine (Web Animations, on the
 * compositor) like PageTransition / ScreenPush - not framer-motion's `x`,
 * which is stepped from JavaScript every frame: a screen that loads and
 * renders its data while it slides in (Stores, Reports, Payouts) stalled
 * those frames on phones and the slide jumped / flickered.
 */
import React from 'react'
import { useReducedMotion } from 'framer-motion'
import { pushLook } from '@/lib/pushLook'
import { move } from '@/lib/pushMove'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DESKTOP_QUERY, PUSH_PARALLAX, PUSH_OPEN_MS, PUSH_BACK_MS, PUSH_EASE_CSS, DESKTOP_FADE_KEYFRAMES, DESKTOP_FADE_MS } from '@/lib/motion'

const OPEN_MS = PUSH_OPEN_MS
const BACK_MS = PUSH_BACK_MS
const EASE = PUSH_EASE_CSS

export function PushLayer({ open, covered = false, zIndex, children }: {
  open: boolean
  /** Another screen is on top: shift left under its dim. */
  covered?: boolean
  zIndex: number
  children: React.ReactNode
}) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  const reduce = useReducedMotion()
  const look = React.useMemo(() => (typeof window === 'undefined' ? { dim: 0.22, shadow: '-10px 0 28px rgba(0,0,0,0.28)' } : pushLook()), [])
  // Stays mounted while it slides out, showing what it showed when it closed.
  const [present, setPresent] = React.useState(open)
  if (open && !present) setPresent(true)
  const last = React.useRef(children)
  if (open) last.current = children
  const panel = React.useRef<HTMLDivElement>(null)
  const veil = React.useRef<HTMLDivElement>(null)
  const shown = React.useRef(false)

  React.useLayoutEffect(() => {
    const p = panel.current, v = veil.current
    if (!p) return
    const k = reduce ? 0 : 1
    if (open) {
      const fresh = !shown.current && !p.style.transform && !p.style.opacity
      shown.current = true
      if (isDesktop) {
        // Desktop: a quick fade in the content area, like desktop pages.
        if (fresh) { p.style.opacity = '1'; if (k) p.animate(DESKTOP_FADE_KEYFRAMES, { duration: DESKTOP_FADE_MS, easing: EASE }) }
        else move(p, 'opacity', '1', DESKTOP_FADE_MS * k)
        return
      }
      move(p, 'transform', covered ? `translateX(${PUSH_PARALLAX})` : 'translateX(0)', (covered || fresh ? OPEN_MS : BACK_MS) * k, fresh ? 'translateX(100%)' : undefined)
      if (v) move(v, 'opacity', String(look.dim), OPEN_MS * k, fresh ? '0' : undefined)
      return
    }
    if (!shown.current) return
    shown.current = false
    const done = () => setPresent(false)
    const out = isDesktop
      ? move(p, 'opacity', '0', 120 * k)
      : (v && move(v, 'opacity', '0', BACK_MS * k), move(p, 'transform', 'translateX(100%)', BACK_MS * k))
    // Cancelled (opened again mid-slide) = stays.
    if (out) out.finished.then(done, () => {})
    else done()
  }, [open, covered, present, isDesktop, reduce, look.dim])

  if (!present) return null
  return (
    <>
      {!isDesktop && <div ref={veil} aria-hidden className="fixed inset-0 pointer-events-none" style={{ background: '#000', zIndex }} />}
      <div ref={panel} className={`${isDesktop ? 'absolute' : 'fixed'} inset-0 flex justify-center bg-bg`}
        style={{ zIndex, boxShadow: isDesktop ? undefined : look.shadow, willChange: 'transform', pointerEvents: open ? undefined : 'none' }}>
        {open ? children : last.current}
      </div>
    </>
  )
}

/** The tab underneath Business screens (the owner's hub, staff mode's home):
 *  while a screen is pushed over it (`covered`, phone only) it shifts
 *  PUSH_PARALLAX left on the push's timing, and the bottom tab bar - which
 *  belongs to the tab, like a page push from a tab (PageTransition) - moves
 *  with it. Returns the style for the tab's root. */
export function useHubShift(covered: boolean): React.CSSProperties {
  const reduce = useReducedMotion()
  // Opening shifts on the open push, coming back on the back push.
  const shiftCss = (on: boolean) => `transform ${reduce ? 0 : on ? OPEN_MS : BACK_MS}ms ${EASE}`
  React.useLayoutEffect(() => {
    const nav = document.querySelector<HTMLElement>('[data-bottom-nav]')
    if (!nav) return
    nav.style.transition = shiftCss(covered)
    nav.style.transform = covered ? `translateX(${PUSH_PARALLAX})` : ''
  }, [covered]) // eslint-disable-line react-hooks/exhaustive-deps
  React.useLayoutEffect(() => () => {
    const nav = document.querySelector<HTMLElement>('[data-bottom-nav]')
    if (nav) { nav.style.transform = ''; nav.style.transition = '' }
  }, [])
  return { transform: covered ? `translateX(${PUSH_PARALLAX})` : undefined, transition: shiftCss(covered), willChange: 'transform' }
}
