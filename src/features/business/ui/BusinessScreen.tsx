/**
 * BusinessScreen — full-height slide-in screen that overlays the tab.
 * Slides from the right; back arrow + title in header; scrolling body; optional sticky footer.
 */
import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from './types'
import { pushLook } from '@/lib/pushLook'
import { PAGE_TRANSITION } from '@/lib/motion'

export interface BusinessScreenProps {
  open: boolean
  title: string
  onBack: () => void
  children: ReactNode
  footer?: ReactNode
}

// Opening/closing uses the app's one page-push motion (same curve + timing as
// PageTransition / ScreenPush): the screen slides the full width in from the
// right on the shared ease-out, over a dim veil of the page beneath, with the
// same edge shadow - instead of the old off-system spring. Leaving is a touch
// quicker on an ease-in, like the OS (matching SHEET_EXIT).
const PANEL_EXIT = { x: '100%', transition: { duration: 0.25, ease: [0.4, 0, 1, 1] as const } }

export function BusinessScreen({ open, title, onBack, children, footer }: BusinessScreenProps) {
  const look = React.useMemo(() => (typeof window === 'undefined' ? { dim: 0.22, shadow: '-10px 0 28px rgba(0,0,0,0.28)' } : pushLook()), [])
  return (
    <AnimatePresence>
      {open && (
        <React.Fragment>
          {/* Dim veil over the page beneath - the same --push-dim the app uses when a page slides in. */}
          <motion.div
            className="fixed inset-0 z-40 pointer-events-none" aria-hidden
            style={{ background: '#000' }}
            initial={{ opacity: 0 }} animate={{ opacity: look.dim }}
            exit={{ opacity: 0, transition: { duration: 0.25, ease: [0.4, 0, 1, 1] } }}
            transition={PAGE_TRANSITION}
          />
        <motion.div
          className="fixed inset-0 z-40 flex justify-center bg-bg"
          style={{ boxShadow: look.shadow }}
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={PANEL_EXIT}
          transition={PAGE_TRANSITION}
        >
          <div className="relative w-full max-w-md flex flex-col h-full">
            {/* Header — the app's standard page header (Profile, Receive…) */}
            <header className="shrink-0 header-row gap-3 px-5 pt-header pb-header bg-bg sticky top-0 z-10">
              <button type="button" aria-label="Go back" onClick={onBack} className="back-btn">
                <ArrowLeft className="w-5 h-5 text-text-primary" />
              </button>
              <h2 className="header-title flex-1 truncate">{title}</h2>
            </header>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto overscroll-contain">
              {children}
            </div>

            {/* Sticky footer — safe-area bottom */}
            {footer && (
              <footer className="shrink-0 px-5 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+16px)] bg-bg border-t border-border">
                {footer}
              </footer>
            )}
          </div>
        </motion.div>
        </React.Fragment>
      )}
    </AnimatePresence>
  )
}
