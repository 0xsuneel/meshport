import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { usePopupOpen } from '@/hooks/usePopupOpen'

// Multichain Hub (phone) — the Transfer and Bring screens open as full pages
// that slide in from the right with the same timing, curve, parallax and dim
// as every other page in the app (see PageTransition). A second page can
// open on top of the first: the one underneath shifts left and dims behind a
// plain black veil (an opacity fade — never a CSS filter, which Android
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

/** A frozen, non-interactive copy of what's on screen right now — without
 *  any fixed-position overlays (sheets) that happen to be inside it. */
function pictureOf(el: HTMLElement): HTMLElement {
  const node = el.cloneNode(true) as HTMLElement
  const orig = el.querySelectorAll<HTMLElement>('*')
  const copy = node.querySelectorAll<HTMLElement>('*')
  const drop: HTMLElement[] = []
  for (let i = 0; i < orig.length && i < copy.length; i++) {
    const o = orig[i], c = copy[i]
    if (o.scrollTop) c.dataset.mpScrollTop = String(o.scrollTop)
    if (getComputedStyle(o).position === 'fixed') drop.push(c)
    if (c.id) c.removeAttribute('id')
    if (c.hasAttribute('data-amount-keypad-sheet')) c.removeAttribute('data-amount-keypad-sheet')
  }
  drop.forEach(c => c.remove())
  return node
}

/**
 * Screens that follow one another inside a Hub page (e.g. Bring: the amount
 * form → processing → Track Progress). When `screenKey` changes, the new
 * screen slides in from the right over a picture of the old one, which
 * shifts left and dims — the same push as opening a page. The children are
 * never remounted; only what they render changes.
 */
export function HubPush({ screenKey, children }: { screenKey: string; children: ReactNode }) {
  const reduce = useReducedMotion()
  const hostRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef<HTMLDivElement>(null)
  const shown = useRef(screenKey)
  const snap = useRef<{ key: string; node: HTMLElement } | null>(null)
  const cleanup = useRef<(() => void) | null>(null)

  // About to change screens: picture the old one while it's still on screen
  // (render runs before React touches the DOM).
  if (!reduce && shown.current !== screenKey && snap.current?.key !== screenKey && liveRef.current) {
    try { snap.current = { key: screenKey, node: pictureOf(liveRef.current) } } catch { snap.current = null }
  }

  useLayoutEffect(() => {
    if (shown.current === screenKey) return
    shown.current = screenKey
    cleanup.current?.()
    const s = snap.current
    snap.current = null
    const host = hostRef.current, live = liveRef.current
    if (!s || s.key !== screenKey || !host || !live) return

    const opts: KeyframeAnimationOptions = { duration: OPEN_S * 1000, easing: `cubic-bezier(${EASE.join(',')})`, fill: 'both' }
    const layer = document.createElement('div')
    layer.setAttribute('aria-hidden', 'true')
    Object.assign(layer.style, { position: 'absolute', inset: '0', zIndex: '1', pointerEvents: 'none', overflow: 'hidden', background: 'var(--bg)' })
    Object.assign(s.node.style, { position: 'absolute', inset: '0' })
    layer.appendChild(s.node)
    const veil = document.createElement('div')
    Object.assign(veil.style, { position: 'absolute', inset: '0', zIndex: '2', background: '#000', opacity: '0', pointerEvents: 'none' })
    host.appendChild(layer)
    host.appendChild(veil)
    s.node.querySelectorAll<HTMLElement>('[data-mp-scroll-top]').forEach(el => { el.scrollTop = Number(el.dataset.mpScrollTop) })
    const prev = { position: live.style.position, zIndex: live.style.zIndex, background: live.style.background, boxShadow: live.style.boxShadow }
    Object.assign(live.style, { position: 'relative', zIndex: '3', background: 'var(--bg)', boxShadow: '-10px 0 28px rgba(0,0,0,0.28)' })

    const anims = [
      live.animate([{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }], opts),
      layer.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${PARALLAX})` }], opts),
      veil.animate([{ opacity: 0 }, { opacity: DIM }], opts),
    ]
    let done = false
    const finish = () => {
      if (done) return
      done = true
      anims.forEach(a => { try { a.cancel() } catch { /* already gone */ } })
      layer.remove()
      veil.remove()
      Object.assign(live.style, prev)
      if (cleanup.current === finish) cleanup.current = null
    }
    cleanup.current = finish
    Promise.all(anims.map(a => a.finished)).then(finish, finish)
  }, [screenKey])

  useLayoutEffect(() => () => cleanup.current?.(), [])

  return (
    <div ref={hostRef} style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div ref={liveRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>{children}</div>
    </div>
  )
}
