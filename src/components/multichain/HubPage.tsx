import { useMemo, type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { usePopupOpen } from '@/hooks/usePopupOpen'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { pushLook } from '@/lib/pushLook'
import { DESKTOP_QUERY, EASE_OUT, PUSH_OPEN_MS, PUSH_BACK_MS, PUSH_PARALLAX, DESKTOP_FADE_Y, DESKTOP_FADE_TRANSITION, DESKTOP_FADE_MS } from '@/lib/motion'

// Multichain Hub (phone) - the Transfer and Bring screens open as full pages
// that slide in from the right with the same timing, curve, parallax, dim and
// edge shadow as every other page in the app (PUSH_* in lib/motion, the dim
// and shadow from the theme via pushLook - see PageTransition / PushLayer). A
// second page can open on top of the first: the one underneath shifts left
// and dims behind a plain black veil (an opacity fade - never a CSS filter,
// which Android re-rasterises every frame and shows as flicker).
/** Desktop: the Hub's right-hand panel, where every Transfer / Bring step opens. */
export const HUB_PANEL_WIDTH = 'min(460px, 100vw)'
/** The panel's own box, for screens drawn outside HubPage (Transfer's processing). */
export const HUB_PANEL_BOX = {
  position: 'fixed', top: 0, right: 0, bottom: 0, width: HUB_PANEL_WIDTH,
  background: 'var(--bg)', borderLeft: '1px solid var(--border)', boxShadow: '-16px 0 40px -12px rgba(0,0,0,0.35)',
} as const
const EASE = EASE_OUT
const OPEN_S = PUSH_OPEN_MS / 1000
const BACK_S = PUSH_BACK_MS / 1000
const PARALLAX = PUSH_PARALLAX

function Panel({ behind, level, header, footer, children }: {
  behind: boolean; level: 0 | 1; header?: ReactNode; footer?: ReactNode; children: ReactNode
}) {
  // While a Hub page is up, blurs on the Hub underneath are switched off (as
  // for any popup). Holding this for the page's whole life also means a
  // picker opened on top of it no longer turns the blurs off and on again,
  // which is what flashed the screen when the chain picker closed.
  usePopupOpen()
  const reduce = useReducedMotion()
  const look = useMemo(() => pushLook(), [])
  const dim = look.dim
  // Desktop: the same phone screens, as a panel on the right of the window
  // with the desktop page fade (DESKTOP_FADE_*) - no full-width slide.
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  if (isDesktop) {
    const fade = reduce ? { duration: 0 } : DESKTOP_FADE_TRANSITION
    return (<>
      {level === 0 && (
        <motion.div aria-hidden initial={{ opacity: 0 }} animate={{ opacity: dim }} exit={{ opacity: 0 }} transition={fade}
          // Blocks the page behind while the panel is open.
          style={{ position: 'fixed', inset: 0, zIndex: 29, background: '#000' }} />
      )}
      <motion.div data-hub-page=""
        initial={{ opacity: 0, y: DESKTOP_FADE_Y }}
        animate={{ opacity: 1, y: 0 }}
        variants={{ leave: (under?: boolean) => under
          // Another page is fading in over this one: stay until it's there.
          ? { opacity: 0, transition: { delay: reduce ? 0 : DESKTOP_FADE_MS / 1000, duration: 0 } }
          : { opacity: 0, transition: fade } }}
        exit="leave"
        transition={fade}
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 30 + level * 2, width: HUB_PANEL_WIDTH,
          background: 'var(--bg)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
          borderLeft: '1px solid var(--border)', boxShadow: '-16px 0 40px -12px rgba(0,0,0,0.35)',
        }}>
        {header}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column' }}>{children}</div>
        {footer && (
          <div style={{ flexShrink: 0, padding: '10px 16px 16px' }}>{footer}</div>
        )}
        <motion.div aria-hidden initial={false} animate={{ opacity: behind ? dim : 0 }} transition={fade}
          style={{ position: 'absolute', inset: 0, background: '#000', pointerEvents: 'none' }} />
      </motion.div>
    </>)
  }
  return (<>
    {/* The first page dims the Hub behind it, like any page opening. */}
    {level === 0 && (
      <motion.div aria-hidden initial={{ opacity: 0 }} animate={{ opacity: dim }}
        exit={{ opacity: 0, transition: { duration: reduce ? 0 : BACK_S, ease: EASE } }}
        transition={{ duration: reduce ? 0 : OPEN_S, ease: EASE }}
        style={{ position: 'fixed', inset: 0, zIndex: 29, maxWidth: 430, margin: '0 auto', background: '#000', pointerEvents: 'none' }} />
    )}
    <motion.div data-hub-page=""
      initial={{ x: '100%' }}
      animate={{ x: behind ? PARALLAX : 0 }}
      variants={{ leave: (under?: boolean) => under
        // Another page is sliding in over this one: stay put until it has
        // arrived, instead of sliding off underneath it.
        ? { opacity: 0, transition: { delay: reduce ? 0 : OPEN_S, duration: 0 } }
        : { x: '100%', transition: { duration: reduce ? 0 : BACK_S, ease: EASE } } }}
      exit="leave"
      transition={{ duration: reduce ? 0 : (behind ? OPEN_S : BACK_S), ease: EASE }}
      style={{
        position: 'fixed', inset: 0, zIndex: 30 + level * 2, maxWidth: 430, margin: '0 auto',
        background: 'var(--bg)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        paddingTop: 'env(safe-area-inset-top, 0px)', boxShadow: look.shadow,
      }}>
      {header}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column' }}>{children}</div>
      {footer && (
        <div style={{ flexShrink: 0, padding: '10px 16px calc(env(safe-area-inset-bottom, 0px) + 16px)' }}>{footer}</div>
      )}
      {/* Dims this page while another one is open on top of it. */}
      <motion.div aria-hidden initial={false} animate={{ opacity: behind ? dim : 0 }}
        transition={{ duration: reduce ? 0 : (behind ? OPEN_S : BACK_S), ease: EASE }}
        style={{ position: 'absolute', inset: 0, background: '#000', pointerEvents: 'none' }} />
    </motion.div>
  </>)
}

export function HubPage({ open, level = 0, behind = false, leaveUnder = false, header, footer, children }: {
  open: boolean
  /** 0 = first page, 1 = a page opened on top of it. */
  level?: 0 | 1
  /** Another page is open on top of this one. */
  behind?: boolean
  /** It's closing because another page is opening over it (Transfer's
   *  Review → processing): it stays where it is until that page has
   *  arrived, then goes, instead of sliding off underneath it. */
  leaveUnder?: boolean
  header?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <AnimatePresence custom={leaveUnder}>
      {open && <Panel behind={behind} level={level} header={header} footer={footer}>{children}</Panel>}
    </AnimatePresence>
  )
}

/** The app's usual back arrow (same as every page header) for a HubPage's top bar. */
export function HubPageBack({ onClick, label = 'Back' }: { onClick: () => void; label?: string }) {
  return (
    <button onClick={onClick} aria-label={label} className="back-btn">
      <ArrowLeft className="w-5 h-5 text-text-primary" />
    </button>
  )
}

// Screens inside a Hub page push like pages (see ScreenPush).
export { ScreenPush as HubPush } from '@/components/ui/ScreenPush'
