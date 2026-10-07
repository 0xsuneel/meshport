import type { ReactNode, CSSProperties } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { sheetDrag } from '@/lib/sheetDrag'

// Multichain Hub (phone) — the Transfer and Bring forms open as sheets that
// rise from the bottom over the Hub, like a curtain, and their sections float
// in one after another. A second sheet can open on top of the first: the one
// underneath then shrinks back a little and dims, and comes forward again
// when the top one closes.
const EASE = [0.32, 0.72, 0, 1] as const

export function HubSheet({ id, open, onClose, level = 0, behind = false, backdrop = true, header, footer, children }: {
  id: string
  open: boolean
  /** Backdrop tap / drag down. */
  onClose: () => void
  /** 0 = first sheet, 1 = a sheet stacked on top of it. */
  level?: 0 | 1
  /** Another sheet is open on top of this one. */
  behind?: boolean
  backdrop?: boolean
  header?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  const reduce = useReducedMotion()
  const z = 30 + level * 2
  return (
    <AnimatePresence>
      {open && (
        <>
          {backdrop && (
            <motion.div key={`${id}-bg`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }} onClick={onClose}
              style={{ position: 'fixed', inset: 0, zIndex: z - 1, maxWidth: 430, margin: '0 auto', background: 'rgba(0,0,0,0.45)' }} />
          )}
          <motion.div key={id} data-hub-sheet="" {...sheetDrag(id, onClose)}
            initial={{ y: '100%' }}
            animate={{ y: 0, scale: behind ? 0.95 : 1, filter: behind ? 'brightness(0.6)' : 'brightness(1)' }}
            exit={{ y: '100%', transition: { duration: 0.26, ease: [0.4, 0, 1, 1] } }}
            transition={{ duration: reduce ? 0 : 0.5, ease: EASE }}
            style={{
              position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: z, maxWidth: 430, margin: '0 auto',
              top: `calc(env(safe-area-inset-top, 0px) + ${16 + level * 14}px)`,
              transformOrigin: 'top center', background: 'var(--bg)',
              borderRadius: '26px 26px 0 0', borderTop: '1px solid var(--border)',
              boxShadow: '0 -12px 40px rgba(0,0,0,0.35)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}>
            <div data-sheet-handle style={{ width: 38, height: 4, borderRadius: 2, flexShrink: 0, margin: '9px auto 2px',
              background: 'color-mix(in srgb, var(--text-primary) 18%, transparent)' }} />
            {header}
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>{children}</div>
            {footer && (
              <div style={{ flexShrink: 0, padding: '10px 18px calc(env(safe-area-inset-bottom, 0px) + 16px)' }}>{footer}</div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

/** A section inside a HubSheet — floats in shortly after the sheet arrives,
 *  each `i` a little after the one before. */
export function HubSheetItem({ i, children, style }: { i: number; children: ReactNode; style?: CSSProperties }) {
  const reduce = useReducedMotion()
  return (
    <motion.div initial={reduce ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: 0.16 + i * 0.06 }} style={style}>
      {children}
    </motion.div>
  )
}

/** Round icon button for a sheet's top bar (close ✕ / back ‹). */
export function HubSheetIconButton({ kind, onClick, label }: { kind: 'close' | 'back'; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-label={label} style={{ width: 34, height: 34, borderRadius: '50%', flexShrink: 0, display: 'flex',
      alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)',
      border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        {kind === 'close' ? <path d="M18 6L6 18M6 6l12 12"/> : <path d="M15 18l-6-6 6-6"/>}
      </svg>
    </button>
  )
}
