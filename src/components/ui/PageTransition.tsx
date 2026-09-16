import { motion, useReducedMotion } from 'framer-motion'
import type { ReactNode } from 'react'
import { useNavigationType } from 'react-router-dom'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import {
  DESKTOP_FADE_Y, DESKTOP_FADE_TRANSITION,
  MOBILE_TAB_FADE_Y, MOBILE_TAB_FADE_TRANSITION,
  MOBILE_SLIDE_X, MOBILE_SLIDE_TRANSITION,
} from '@/lib/motion'

interface PageTransitionProps {
  children: ReactNode
  /** Usually the route pathname — remounting on key change is what makes
   * a fresh transition play on every navigation. */
  locationKey: string
}

// Drill-in / hierarchical routes (reached by "pushing" deeper from a list or
// hub, with an implied way back) get a directional mobile slide. Everything
// else — tab roots, top-level features, deep-linked pages — keeps the fade+
// rise treatment, since there's no "back" relationship to make a slide read
// correctly. Desktop always fades regardless of this classification.
const HIERARCHICAL_ROUTE_PATTERNS = [
  /^\/activity\/.+/,
  /^\/p2p\/(offer|trade)\/.+/,
  /^\/chat\/.+/,
  /^\/(security|security\/change-passcode|appearance|edit-profile|backup|notifications|feature-guide|about|terms-privacy|help-support)$/,
]

function isHierarchicalRoute(pathname: string) {
  return HIERARCHICAL_ROUTE_PATTERNS.some(re => re.test(pathname))
}

/**
 * Wraps <Outlet/> in AppLayout so every route transitions consistently.
 * Deliberately enter-only, no AnimatePresence/exit: each page manages its
 * own mount lifecycle (data fetches, subscriptions, cleanup) and its own
 * scroll container, so delaying unmount for an exit animation risks stale
 * subscriptions and scroll-position bugs for very little visual gain in a
 * single-pane mobile shell where the old screen is never visible
 * alongside the new one anyway.
 */
export function PageTransition({ children, locationKey }: PageTransitionProps) {
  const reduceMotion = useReducedMotion()
  const navigationType = useNavigationType()
  const isBack = navigationType === 'POP'
  // Mobile: `overflow:hidden` here is intentional — every mobile page's own
  // root is built as flex:1+overflow-hidden with an inner overflow-y-auto
  // scroll container matched exactly to this box, so this outer hidden is
  // just belt-and-suspenders against rubber-banding past the page shell.
  // Desktop pages that pack a lot of content into a single column (e.g. a
  // 2-column transaction flow's Review/Progress/Done steps) don't always
  // have that exact 1:1 match — a bounded-height, hard-clipping ancestor
  // here would silently clip their tail (the primary button, or the bottom
  // of a success screen) with no way to reach it. `visible` on desktop lets
  // AppLayout's own overflowY:'auto' content wrapper (the real scrolling
  // ancestor one level up) catch anything a page's internal scroll
  // container doesn't already handle, as a safety net rather than the
  // single source of truth — pages keep managing their own scroll first.
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const isSlide = !isDesktop && isHierarchicalRoute(locationKey)

  const initial = isSlide
    ? { opacity: 0, x: isBack ? -MOBILE_SLIDE_X : MOBILE_SLIDE_X }
    : { opacity: 0, y: isDesktop ? DESKTOP_FADE_Y : MOBILE_TAB_FADE_Y }
  const animate = isSlide ? { opacity: 1, x: 0 } : { opacity: 1, y: 0 }
  const transition = isSlide
    ? MOBILE_SLIDE_TRANSITION
    : (isDesktop ? DESKTOP_FADE_TRANSITION : MOBILE_TAB_FADE_TRANSITION)

  return (
    <motion.div
      key={locationKey}
      initial={reduceMotion ? false : initial}
      animate={animate}
      transition={transition}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: isDesktop ? 'visible' : 'hidden', minHeight: 0 }}
    >
      {children}
    </motion.div>
  )
}
