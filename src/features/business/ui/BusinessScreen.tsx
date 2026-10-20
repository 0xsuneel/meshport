/**
 * BusinessScreen — full-height slide-in screen that overlays the tab.
 * Slides from the right; back arrow + title in header; scrolling body; optional sticky footer.
 */
import React from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from './types'
import { pushLook } from '@/lib/pushLook'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { ScreenPush } from '@/components/ui/ScreenPush'
import { DESKTOP_QUERY, DESKTOP_FADE_TRANSITION, EASE_OUT, PAGE_SLIDE_X, PAGE_TRANSITION } from '@/lib/motion'

export interface BusinessScreenProps {
  open: boolean
  title: string
  onBack: () => void
  children: ReactNode
  footer?: ReactNode
  /** A step inside this screen (a customer, a store being edited, a payout
   *  draft); '' or absent = the screen's first view. Changing it pushes the
   *  new view in like any other step (ScreenPush); going back to the first
   *  view slides back. */
  step?: string
  /** The body is a flex column that fills the screen and scrolls itself
   *  (Collect payment's forms, which pin their own buttons). */
  fill?: boolean
}

/** Where a screen sits in the Business screen stack: `level` 0 is opened from
 *  the tab, 1 from a level-0 screen, …; `covered` = another screen is on top
 *  of it right now. Set by BusinessPage (and CashOut for its trade screen). */
export const ScreenLevel = React.createContext<{ level: number; covered: boolean }>({ level: 0, covered: false })
export const useScreenLevel = () => React.useContext(ScreenLevel)

// Opening/closing is the app's one page push (PageTransition / ScreenPush):
// the screen slides the full width in from the right over a dim veil with the
// edge shadow, while the screen (or tab) beneath it shifts 28% left; back
// slides it off to the right as the one beneath comes back - 300ms in, 250ms
// back, both on the same ease-out. Desktop: a quick fade in the content area,
// like desktop pages (no sliding over the sidebar).
export const PUSH_BACK = { duration: 0.25, ease: EASE_OUT }
const PANEL_EXIT = { x: '100%', transition: PUSH_BACK }
const DESKTOP_EXIT = { opacity: 0, transition: { duration: 0.12, ease: EASE_OUT } }

export function BusinessScreen({ open, title, onBack, children, footer, step = '', fill = false }: BusinessScreenProps) {
  const look = React.useMemo(() => (typeof window === 'undefined' ? { dim: 0.22, shadow: '-10px 0 28px rgba(0,0,0,0.28)' } : pushLook()), [])
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  const reduce = useReducedMotion()
  const { level, covered } = useScreenLevel()
  // Above the Manage orders / money panel (z-40), each level above the last.
  const z = 41 + level
  // Uncovering is a back move: 250ms, like the screen sliding off on top.
  const slide = isDesktop ? undefined : { x: covered ? `-${PAGE_SLIDE_X}` : 0, transition: covered ? PAGE_TRANSITION : PUSH_BACK }
  return (
    <AnimatePresence>
      {open && (
        <React.Fragment>
          {/* Dim veil over the page beneath - the same --push-dim the app uses when a page slides in. */}
          {!isDesktop && (
            <motion.div
              className="fixed inset-0 pointer-events-none" aria-hidden
              style={{ background: '#000', zIndex: z }}
              initial={{ opacity: 0 }} animate={{ opacity: look.dim }}
              exit={{ opacity: 0, transition: PUSH_BACK }}
              transition={reduce ? { duration: 0 } : PAGE_TRANSITION}
            />
          )}
        <motion.div
          className={`${isDesktop ? 'absolute' : 'fixed'} inset-0 flex justify-center bg-bg`}
          style={{ zIndex: z, boxShadow: isDesktop ? undefined : look.shadow }}
          initial={isDesktop ? { opacity: 0, y: 4 } : { x: '100%' }}
          animate={isDesktop ? { opacity: 1, y: 0 } : slide}
          exit={isDesktop ? DESKTOP_EXIT : PANEL_EXIT}
          transition={reduce ? { duration: 0 } : isDesktop ? DESKTOP_FADE_TRANSITION : PAGE_TRANSITION}
        >
          {/* Its own views (a customer, a store being edited) are pushed like
              Pay's steps: in from the right, back to the first view from the left. */}
          <ScreenPush screenKey={step || '·'} back={!step} style={{ width: '100%', maxWidth: 448 }}>
            {/* Header — the app's standard page header (Profile, Receive…) */}
            <header className="shrink-0 header-row gap-3 px-5 pt-header pb-header bg-bg sticky top-0 z-10">
              <button type="button" aria-label="Go back" onClick={onBack} className="back-btn">
                <ArrowLeft className="w-5 h-5 text-text-primary" />
              </button>
              <h2 className="header-title flex-1 truncate">{title}</h2>
            </header>

            {/* Scrollable body */}
            <div className={fill ? 'flex-1 min-h-0 flex flex-col' : 'flex-1 overflow-y-auto overscroll-contain'}>
              {children}
            </div>

            {/* Sticky footer — safe-area bottom */}
            {footer && (
              <footer className="shrink-0 px-5 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+16px)] bg-bg border-t border-border">
                {footer}
              </footer>
            )}
          </ScreenPush>
        </motion.div>
        </React.Fragment>
      )}
    </AnimatePresence>
  )
}
