import { motion, useReducedMotion } from 'framer-motion'
import type { ReactNode } from 'react'
import { useMediaQuery } from '@/hooks/useMediaQuery'

interface PageTransitionProps {
  children: ReactNode
  /** Usually the route pathname — remounting on key change is what makes
   * a fresh fade+rise play on every navigation. */
  locationKey: string
}

/**
 * Wraps <Outlet/> in AppLayout so every route gets the same subtle
 * fade + 8px rise on entry (220-280ms per the design spec). Deliberately
 * enter-only, no AnimatePresence/exit: each page manages its own mount
 * lifecycle (data fetches, subscriptions, cleanup) and its own scroll
 * container, so delaying unmount for an exit animation risks stale
 * subscriptions and scroll-position bugs for very little visual gain in a
 * single-pane mobile shell where the old screen is never visible
 * alongside the new one anyway.
 */
export function PageTransition({ children, locationKey }: PageTransitionProps) {
  const reduceMotion = useReducedMotion()
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
  return (
    <motion.div
      key={locationKey}
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: 'easeOut' }}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: isDesktop ? 'visible' : 'hidden', minHeight: 0 }}
    >
      {children}
    </motion.div>
  )
}
