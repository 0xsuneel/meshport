/**
 * BusinessScreen — full-height slide-in screen that overlays the tab.
 * Slides from the right; back arrow + title in header; scrolling body; optional sticky footer.
 */
import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from './types'
import { springs } from './types'

export interface BusinessScreenProps {
  open: boolean
  title: string
  onBack: () => void
  children: ReactNode
  footer?: ReactNode
}

export function BusinessScreen({ open, title, onBack, children, footer }: BusinessScreenProps) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-40 flex justify-center bg-bg"
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={springs.sheet}
        >
          <div className="relative w-full max-w-md flex flex-col h-full">
            {/* Header — safe-area top */}
            <header className="shrink-0 flex items-center gap-3 px-4 pt-[calc(env(safe-area-inset-top,0px)+10px)] pb-3 bg-bg border-b border-border sticky top-0 z-10">
              <button
                type="button"
                aria-label="Go back"
                onClick={onBack}
                className="size-10 flex items-center justify-center rounded-2xl text-text-secondary hover:bg-border/40 active:scale-95 transition-all shrink-0"
              >
                <ArrowLeft className="size-5" />
              </button>
              <h2 className="display text-base font-semibold text-text-primary flex-1 truncate">
                {title}
              </h2>
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
      )}
    </AnimatePresence>
  )
}
