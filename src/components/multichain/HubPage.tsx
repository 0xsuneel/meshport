import { type ReactNode } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { usePopupOpen } from '@/hooks/usePopupOpen'

// Multichain Hub (phone) - the Transfer and Bring screens open as full pages
// that slide in from the right with the same timing, curve, parallax and dim
// as every other page in the app (see PageTransition). A second page can
// open on top of the first: the one underneath shifts left and dims behind a
// plain black veil (an opacity fade - never a CSS filter, which Android
// re-rasterises every frame and shows as flicker).
const EASE = [0.32, 0.72, 0, 1] as const
const OPEN_S = 0.3
const BACK_S = 0.25
const PARALLAX = '-28%'
const DIM = 0.22

function Panel({ behind, level, header, footer, children }: {
  behind: boolean; level: 0 | 1; header?: ReactNode; footer?: ReactNode; children: ReactNode
}) {
  // While a Hub page is up, blurs on the Hub underneath are switched off (as
  // for any popup). Holding this for the page's whole life also means a
  // picker opened on top of it no longer turns the blurs off and on again,
  // which is what flashed the screen when the chain picker closed.
  usePopupOpen()
  const reduce = useReducedMotion()
  return (<>
    {/* The first page dims the Hub behind it, like any page opening. */}
    {level === 0 && (
      <motion.div aria-hidden initial={{ opacity: 0 }} animate={{ opacity: DIM }}
        exit={{ opacity: 0, transition: { duration: reduce ? 0 : BACK_S, ease: EASE } }}
        transition={{ duration: reduce ? 0 : OPEN_S, ease: EASE }}
        style={{ position: 'fixed', inset: 0, zIndex: 29, maxWidth: 430, margin: '0 auto', background: '#000', pointerEvents: 'none' }} />
    )}
    <motion.div data-hub-page=""
      initial={{ x: '100%' }}
      animate={{ x: behind ? PARALLAX : 0 }}
      exit={{ x: '100%', transition: { duration: reduce ? 0 : BACK_S, ease: EASE } }}
      transition={{ duration: reduce ? 0 : OPEN_S, ease: EASE }}
      style={{
        position: 'fixed', inset: 0, zIndex: 30 + level * 2, maxWidth: 430, margin: '0 auto',
        background: 'var(--bg)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        paddingTop: 'env(safe-area-inset-top, 0px)', boxShadow: '-10px 0 28px rgba(0,0,0,0.28)',
      }}>
      {header}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column' }}>{children}</div>
      {footer && (
        <div style={{ flexShrink: 0, padding: '10px 16px calc(env(safe-area-inset-bottom, 0px) + 16px)' }}>{footer}</div>
      )}
      {/* Dims this page while another one is open on top of it. */}
      <motion.div aria-hidden initial={false} animate={{ opacity: behind ? DIM : 0 }}
        transition={{ duration: reduce ? 0 : (behind ? OPEN_S : BACK_S), ease: EASE }}
        style={{ position: 'absolute', inset: 0, background: '#000', pointerEvents: 'none' }} />
    </motion.div>
  </>)
}

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
  return (
    <AnimatePresence>
      {open && <Panel behind={behind} level={level} header={header} footer={footer}>{children}</Panel>}
    </AnimatePresence>
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

// Screens inside a Hub page push like pages (see ScreenPush).
export { ScreenPush as HubPush } from '@/components/ui/ScreenPush'
