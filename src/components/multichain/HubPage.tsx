import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useReducedMotion } from 'framer-motion'
import { PopupOpen } from '@/hooks/usePopupOpen'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { pushLook } from '@/lib/pushLook'
import { move } from '@/lib/pushMove'
import { DESKTOP_QUERY, PUSH_EASE_CSS, PUSH_OPEN_MS, PUSH_BACK_MS, PUSH_PARALLAX, DESKTOP_FADE_KEYFRAMES, DESKTOP_FADE_MS } from '@/lib/motion'

// Multichain Hub (phone) - the Transfer and Bring screens open as full pages
// that slide in from the right with the same timing, curve, parallax, dim and
// edge shadow as every other page in the app (PUSH_* in lib/motion, the dim
// and shadow from the theme via pushLook - see PageTransition / PushLayer). A
// second page can open on top of the first: the one underneath shifts left
// and dims behind a plain black veil (an opacity fade - never a CSS filter,
// which Android re-rasterises every frame and shows as flicker).
//
// Like PushLayer it moves on the browser's own animation engine (lib/
// pushMove), not framer-motion's `x`: Review starts its fee calculation (and
// loads the transfer SDK) as it opens, and a JavaScript-stepped slide stalled
// on that work - the page jumped and flickered on its way in.
/** Desktop: the Hub's right-hand panel, where every Transfer / Bring step opens. */
export const HUB_PANEL_WIDTH = 'min(460px, 100vw)'
/** The panel's own box, for screens drawn outside HubPage (Transfer's processing). */
export const HUB_PANEL_BOX = {
  position: 'fixed', top: 0, right: 0, bottom: 0, width: HUB_PANEL_WIDTH,
  background: 'var(--bg)', borderLeft: '1px solid var(--border)', boxShadow: '-16px 0 40px -12px rgba(0,0,0,0.35)',
} as const
const EASE = PUSH_EASE_CSS
/** Desktop panels leave on a quick fade. */
const DESKTOP_OUT_MS = 120

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
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  const reduce = useReducedMotion()
  const look = useMemo(() => pushLook(), [])
  // Stays mounted while it leaves, showing what it showed when it closed.
  const [present, setPresent] = useState(open)
  if (open && !present) setPresent(true)
  const last = useRef({ header, footer, children })
  if (open) last.current = { header, footer, children }
  const openRef = useRef(open)
  openRef.current = open
  const leaveUnderRef = useRef(leaveUnder)
  leaveUnderRef.current = leaveUnder
  const panel = useRef<HTMLDivElement>(null)
  const veil = useRef<HTMLDivElement>(null)
  const dim = useRef<HTMLDivElement>(null)
  const shown = useRef(false)

  useLayoutEffect(() => {
    const p = panel.current, v = veil.current, d = dim.current
    if (!p) return
    const k = reduce ? 0 : 1
    if (open) {
      const fresh = !shown.current
      shown.current = true
      if (isDesktop) {
        // Desktop: the desktop page fade, in the right-hand panel. A page
        // opened on top covers this one exactly, so this one doesn't dim
        // under it (that showed through the top page's fade as a blink).
        if (fresh) {
          p.style.opacity = '1'
          if (k) p.animate(DESKTOP_FADE_KEYFRAMES, { duration: DESKTOP_FADE_MS, easing: EASE })
          if (d) move(d, 'opacity', String(look.dim), DESKTOP_FADE_MS * k, '0')
        }
        if (v) move(v, 'opacity', '0', 0)
        return
      }
      move(p, 'transform', behind ? `translateX(${PUSH_PARALLAX})` : 'translateX(0)', (behind || fresh ? PUSH_OPEN_MS : PUSH_BACK_MS) * k, fresh ? 'translateX(100%)' : undefined)
      if (v) move(v, 'opacity', behind ? String(look.dim) : '0', (behind ? PUSH_OPEN_MS : PUSH_BACK_MS) * k, fresh ? '0' : undefined)
      if (fresh && d) move(d, 'opacity', String(look.dim), PUSH_OPEN_MS * k, '0')
      return
    }
    if (!shown.current) return
    shown.current = false
    // Opened again before it finished leaving: stays.
    const done = () => { if (!openRef.current) setPresent(false) }
    if (leaveUnderRef.current) {
      // Another page is arriving over it: stay put until it has, then go.
      setTimeout(done, (isDesktop ? DESKTOP_FADE_MS : PUSH_OPEN_MS) * k)
      return
    }
    if (d) move(d, 'opacity', '0', (isDesktop ? DESKTOP_OUT_MS : PUSH_BACK_MS) * k)
    const out = isDesktop
      ? move(p, 'opacity', '0', DESKTOP_OUT_MS * k)
      : move(p, 'transform', 'translateX(100%)', PUSH_BACK_MS * k)
    if (out) out.finished.then(done, () => {})
    else done()
  }, [open, behind, present, isDesktop, reduce, look.dim])

  if (!present) return null
  const c = open ? { header, footer, children } : last.current
  return (<>
    {/* While a Hub page is up, blurs on the Hub underneath are switched off
        (as for any popup), for the page's whole life. */}
    <PopupOpen />
    {/* The first page dims the Hub behind it, like any page opening (and on
        desktop blocks it while the panel is open). */}
    {level === 0 && (
      <div ref={dim} aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 29, background: '#000', opacity: 0,
        ...(isDesktop ? {} : { maxWidth: 430, margin: '0 auto', pointerEvents: 'none' }) }} />
    )}
    <div ref={panel} data-hub-page="" style={{
      ...(isDesktop
        ? { position: 'fixed', top: 0, right: 0, bottom: 0, width: HUB_PANEL_WIDTH, borderLeft: '1px solid var(--border)', boxShadow: '-16px 0 40px -12px rgba(0,0,0,0.35)' }
        : { position: 'fixed', inset: 0, maxWidth: 430, margin: '0 auto', paddingTop: 'env(safe-area-inset-top, 0px)', boxShadow: look.shadow, willChange: 'transform' }),
      zIndex: 30 + level * 2, background: 'var(--bg)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
      pointerEvents: open ? undefined : 'none',
    }}>
      {c.header}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column' }}>{c.children}</div>
      {c.footer && (
        <div style={{ flexShrink: 0, padding: isDesktop ? '10px 16px 16px' : '10px 16px calc(env(safe-area-inset-bottom, 0px) + 16px)' }}>{c.footer}</div>
      )}
      {/* Dims this page while another one is open on top of it (phone). */}
      <div ref={veil} aria-hidden style={{ position: 'absolute', inset: 0, background: '#000', opacity: 0, pointerEvents: 'none' }} />
    </div>
  </>)
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
