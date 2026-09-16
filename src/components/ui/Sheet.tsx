import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { type ReactNode } from 'react'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useVisibleViewportHeight } from '@/hooks/useVisibleViewportHeight'
import { useIsStandalone } from '@/hooks/useIsStandalone'
import { DesktopDialogFrame } from './DesktopDialogFrame'

interface SheetProps {
  isOpen: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  fullHeight?: boolean
  /**
   * 'bottom' (default): slides up from the bottom edge — bounded to the
   * real visible viewport height (see useVisibleViewportHeight), so it
   * stays clear of the browser's own chrome on mobile instead of sitting
   * partly under it.
   * 'center': always renders as a centered dialog, even on mobile. Use this
   * for sheets that must stay clear of that browser chrome instead of
   * hiding behind it.
   */
  variant?: 'bottom' | 'center'
}

export function Sheet({ isOpen, onClose, title, children, fullHeight, variant = 'bottom' }: SheetProps) {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const useCenteredFrame = isDesktop || variant === 'center'
  // Real visible height on mobile — see the hook's own comment. Used to
  // wrap the backdrop+sheet in a box that's exactly as tall as what's
  // actually on-screen, so "bottom-0" below lands at the real visible
  // bottom edge instead of possibly underneath the browser's own chrome.
  const visibleHeight = useVisibleViewportHeight()
  // visualViewport tracks the keyboard reliably but NOT the browser's own
  // persistent toolbar reliably — so on top of the measured height above,
  // add a fixed safety buffer, but only when there's browser chrome to
  // actually buffer against (a real, non-installed browser tab). See
  // useIsStandalone's own comment.
  const isStandalone = useIsStandalone()
  const chromeBuffer = isStandalone ? 0 : 56

  return (
    <AnimatePresence>
      {isOpen && (useCenteredFrame ? (
        // Centered dialog: desktop always gets this, mobile gets it when
        // variant="center" is requested. No drag-handle grabber (that's a
        // bottom-sheet affordance, meaningless for a centered dialog).
        <DesktopDialogFrame onClose={onClose} maxWidth={480}>
          <div className="flex items-center justify-between px-5 pt-4 pb-2">
            {title && <h2 className="text-lg font-bold text-text-primary">{title}</h2>}
            <button
              onClick={onClose}
              className="ml-auto p-2 rounded-full hover:bg-text-primary/10 text-text-secondary transition-colors"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="pb-2">{children}</div>
        </DesktopDialogFrame>
      ) : (
        // Wrapped in a box pinned to the real visible viewport height
        // (not `100%`/`inset-0` of a possibly-taller ancestor) — see
        // useVisibleViewportHeight's comment. Without this, on iPhone
        // Chrome/Safari the sheet's own "bottom-0" could land below the
        // actually-visible area, letting the browser's own address bar /
        // tab bar chrome cover the bottom of the sheet (e.g. a trailing
        // Close button) instead of the sheet sitting cleanly above it.
        <div className="absolute left-0 right-0 top-0 overflow-hidden" style={{ height: visibleHeight ?? '100%' }}>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 bg-black/50 backdrop-blur-sm z-40"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className={`absolute bottom-0 left-0 right-0 z-50 bg-surface rounded-t-[28px] border-t border-border shadow-elevation-3 ${
              fullHeight ? 'h-[90vh]' : 'max-h-[85vh]'
            } overflow-hidden flex flex-col`}
            style={{ paddingBottom: `calc(env(safe-area-inset-bottom) + ${chromeBuffer}px)` }}
          >
            <div className="flex items-center justify-between px-5 pt-4 pb-2 flex-shrink-0">
              <div className="w-10 h-1 bg-text-primary/15 rounded-full mx-auto absolute left-1/2 -translate-x-1/2 top-2" />
              {title && <h2 className="text-lg font-bold text-text-primary mt-2">{title}</h2>}
              <button
                onClick={onClose}
                className="ml-auto p-2 rounded-full hover:bg-text-primary/10 text-text-secondary transition-colors"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">{children}</div>
          </motion.div>
        </div>
      ))}
    </AnimatePresence>
  )
}
