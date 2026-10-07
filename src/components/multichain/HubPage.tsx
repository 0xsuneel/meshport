import type { ReactNode, CSSProperties } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'

// Multichain Hub (phone) — the Transfer and Bring screens open as full pages
// that slide in from the right, the same way every page in the app opens.
// A second page can open on top of the first: the one underneath then shifts
// a little to the left and dims, and comes back when the top one closes.
const EASE = [0.32, 0.72, 0, 1] as const

export function HubPage({ open, level = 0, behind = false, header, footer, children }: {
  open: boolean
  /** 0 = first page, 1 = a page opened on top of it. */
  level?: 0 | 1
  /** Another page is open on top of this one. */
  behind?: boolean
  header?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  const reduce = useReducedMotion()
  return (
    <AnimatePresence>
      {open && (
        <motion.div data-hub-page=""
          initial={{ x: '100%' }}
          animate={{ x: behind ? '-28%' : 0, filter: behind ? 'brightness(0.78)' : 'brightness(1)' }}
          exit={{ x: '100%', transition: { duration: reduce ? 0 : 0.25, ease: EASE } }}
          transition={{ duration: reduce ? 0 : 0.3, ease: EASE }}
          style={{
            position: 'fixed', inset: 0, zIndex: 30 + level * 2, maxWidth: 430, margin: '0 auto',
            background: 'var(--bg)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
            paddingTop: 'env(safe-area-inset-top, 0px)',
            boxShadow: behind ? 'none' : '-12px 0 32px rgba(0,0,0,0.25)',
          }}>
          {header}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column' }}>{children}</div>
          {footer && (
            <div style={{ flexShrink: 0, padding: '10px 16px calc(env(safe-area-inset-bottom, 0px) + 16px)' }}>{footer}</div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** A section inside a HubPage — fades up just after the page arrives, each
 *  `i` a little after the one before. */
export function HubPageItem({ i, children, style }: { i: number; children: ReactNode; style?: CSSProperties }) {
  const reduce = useReducedMotion()
  return (
    <motion.div initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1], delay: 0.12 + i * 0.05 }} style={style}>
      {children}
    </motion.div>
  )
}

/** The app's usual back arrow for a HubPage's top bar. */
export function HubPageBack({ onClick, label = 'Back' }: { onClick: () => void; label?: string }) {
  return (
    <button onClick={onClick} aria-label={label} className="back-btn" style={{ width: 28, height: 28, color: 'var(--text-primary)' }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 18l-6-6 6-6"/>
      </svg>
    </button>
  )
}
