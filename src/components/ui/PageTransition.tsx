import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useNavDirection } from '@/hooks/useNavDirection'

interface PageTransitionProps {
  children: ReactNode
  /** Usually the route pathname — a new key = a new page. */
  locationKey: string
}

// ── Native page push (like PhonePe / Google Pay on a phone) ────────────────
// Open:  the new page slides in from the right edge while the old page shifts
//        left and dims behind it.
// Back:  the current page slides off to the right while the previous page
//        comes back from the left and brightens.
// Tabs:  a quick cross-fade.   First load / reload: no animation at all.
//
// The old page is shown as a frozen PICTURE (a DOM copy, taken just before
// React swaps the pages) — never a second live copy — so no page logic,
// subscription or effect ever runs twice. Everything moves with the
// browser's own animation engine (Web Animations on transform/opacity), on
// the compositor, and the first frame is set before paint: no flicker.
const OPEN_MS = 320
const BACK_MS = 280
const TAB_MS = 150
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'
const PARALLAX = '-28%'
const DIM = 0.22

type Snapshot = {
  key: string; node: HTMLElement; scrolls: Array<[number, number, number]>
  /** Where the old page sat inside the app shell. */
  top: number; height: number
  /** Picture of the bottom tab bar, if it was showing. */
  nav: HTMLElement | null
}

const shellOf = (el: HTMLElement) => (el.closest('[data-page-shell]') as HTMLElement | null) ?? el.parentElement ?? el

/** A frozen, non-interactive copy of the page as it looks right now. */
function takeSnapshot(page: HTMLElement, key: string): Snapshot {
  const node = page.cloneNode(true) as HTMLElement
  const orig = page.querySelectorAll<HTMLElement>('*')
  const copy = node.querySelectorAll<HTMLElement>('*')
  const scrolls: Array<[number, number, number]> = []
  if (page.scrollTop || page.scrollLeft) scrolls.push([-1, page.scrollTop, page.scrollLeft])
  for (let i = 0; i < orig.length && i < copy.length; i++) {
    const o = orig[i], c = copy[i]
    if (o.scrollTop || o.scrollLeft) scrolls.push([i, o.scrollTop, o.scrollLeft])
    if (o instanceof HTMLCanvasElement && c instanceof HTMLCanvasElement) {
      try { c.getContext('2d')?.drawImage(o, 0, 0) } catch { /* tainted — leave blank */ }
    } else if ((o instanceof HTMLInputElement || o instanceof HTMLTextAreaElement) && (c instanceof HTMLInputElement || c instanceof HTMLTextAreaElement)) {
      c.value = o.value
    }
    // No duplicate ids / test hooks while the copy is on screen.
    if (c.id) c.removeAttribute('id')
    if (c.hasAttribute('data-amount-keypad-sheet')) c.removeAttribute('data-amount-keypad-sheet')
  }
  node.removeAttribute('id')
  const shell = shellOf(page)
  const sr = shell.getBoundingClientRect(), pr = page.getBoundingClientRect()
  const liveNav = shell.querySelector<HTMLElement>('[data-bottom-nav]')
  const nav = liveNav ? (liveNav.cloneNode(true) as HTMLElement) : null
  nav?.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'))
  return { key, node, scrolls, top: pr.top - sr.top, height: pr.height, nav }
}

export function PageTransition({ children, locationKey }: PageTransitionProps) {
  const reduceMotion = useReducedMotion()
  const nav = useNavDirection()
  // Desktop keeps a light fade (no sliding in a sidebar layout) and must not
  // clip: AppLayout's own scroller reaches a tall page's tail.
  const isDesktop = useMediaQuery('(min-width: 980px)')

  const hostRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const shownKey = useRef(locationKey)
  const snap = useRef<Snapshot | null>(null)
  const cleanup = useRef<(() => void) | null>(null)

  const willSlide = !isDesktop && !reduceMotion && (nav === 'forward' || nav === 'back')

  // The page is about to change: picture the old one while it's still on
  // screen (render runs before React touches the DOM).
  if (willSlide && shownKey.current !== locationKey && snap.current?.key !== locationKey && pageRef.current) {
    try { snap.current = takeSnapshot(pageRef.current, locationKey) } catch { snap.current = null }
  }

  useLayoutEffect(() => {
    if (shownKey.current === locationKey) return
    shownKey.current = locationKey
    // A new navigation mid-animation: finish the previous one at once.
    cleanup.current?.()
    cleanup.current = null

    const page = pageRef.current
    const host = hostRef.current
    const s = snap.current
    snap.current = null
    if (!page || !host || reduceMotion) return

    if (isDesktop) {
      page.animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: EASE })
      return
    }
    if (nav === 'tab') {
      page.animate([{ opacity: 0 }, { opacity: 1 }], { duration: TAB_MS, easing: EASE })
      return
    }
    if (!willSlide || !s || s.key !== locationKey) return

    const back = nav === 'back'
    const duration = back ? BACK_MS : OPEN_MS
    const opts: KeyframeAnimationOptions = { duration, easing: EASE, fill: 'both' }

    // The whole app shell (page + bottom tab bar) is the stage.
    const shell = shellOf(host)
    const liveNav = shell.querySelector<HTMLElement>('[data-bottom-nav]')
    const navZ = liveNav ? (parseInt(getComputedStyle(liveNav).zIndex, 10) || 30) : 30
    const navBoth = !!(liveNav && s.nav)          // tab bar on both pages: it stays put
    const navArrives = !!(liveNav && !s.nav)      // it belongs to the new page: moves with it

    // Old page picture (with its tab bar, if the new page has none).
    const layer = document.createElement('div')
    layer.setAttribute('aria-hidden', 'true')
    Object.assign(layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden', willChange: 'transform' })
    Object.assign(s.node.style, { position: 'absolute', left: '0', right: '0', top: `${s.top}px`, height: `${s.height}px`, flex: 'none', background: 'var(--bg)' })
    layer.appendChild(s.node)
    if (s.nav && !liveNav) layer.appendChild(s.nav)
    // A dim veil over whichever page sits underneath.
    const veil = document.createElement('div')
    Object.assign(veil.style, { position: 'absolute', inset: '0', background: '#000', pointerEvents: 'none', opacity: '0' })

    // Stacking: the page in front is on top; the tab bar stays on top when
    // both pages have it; when it arrives with the page underneath (back),
    // it goes under the veil and the sliding picture.
    const zBelow = 1, zVeil = back && navArrives ? navZ + 1 : 2, zFront = back && navArrives ? navZ + 2 : 3
    const prevPage = { position: page.style.position, zIndex: page.style.zIndex, background: page.style.background, boxShadow: page.style.boxShadow, willChange: page.style.willChange }
    Object.assign(page.style, { position: 'relative', zIndex: String(back ? zBelow : zFront), background: 'var(--bg)', willChange: 'transform' })
    layer.style.zIndex = String(back ? zFront : zBelow)
    veil.style.zIndex = String(zVeil)
    if (navBoth) { layer.style.zIndex = String(Math.min(Number(layer.style.zIndex), navZ - 1)); veil.style.zIndex = String(Math.min(zVeil, navZ - 1)) }
    shell.appendChild(layer)
    shell.appendChild(veil)
    const copies = s.node.querySelectorAll<HTMLElement>('*')
    for (const [i, t, l] of s.scrolls) {
      const el = i === -1 ? s.node : copies[i]
      if (el) { el.scrollTop = t; el.scrollLeft = l }
    }
    ;(back ? layer : page).style.boxShadow = '-10px 0 28px rgba(0,0,0,0.28)'

    const anims: Animation[] = back
      ? [
          layer.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(100%)' }], opts),
          page.animate([{ transform: `translateX(${PARALLAX})` }, { transform: 'translateX(0)' }], opts),
          veil.animate([{ opacity: DIM }, { opacity: 0 }], opts),
        ]
      : [
          page.animate([{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }], opts),
          layer.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${PARALLAX})` }], opts),
          veil.animate([{ opacity: 0 }, { opacity: DIM }], opts),
        ]
    // A tab bar that belongs to the new page travels with it.
    if (navArrives && liveNav) {
      anims.push(liveNav.animate(back
        ? [{ transform: `translateX(${PARALLAX})` }, { transform: 'translateX(0)' }]
        : [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }], opts))
    }

    let done = false
    const finish = () => {
      if (done) return
      done = true
      anims.forEach(a => { try { a.cancel() } catch { /* already gone */ } })
      layer.remove()
      veil.remove()
      Object.assign(page.style, prevPage)
      if (cleanup.current === finish) cleanup.current = null
    }
    cleanup.current = finish
    Promise.all(anims.map(a => a.finished)).then(finish, finish)
  }, [locationKey])

  // Never leave a picture behind if the shell unmounts mid-animation.
  useLayoutEffect(() => () => cleanup.current?.(), [])

  return (
    <div ref={hostRef}
      style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: isDesktop ? 'visible' : 'hidden' }}>
      <div key={locationKey} ref={pageRef}
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: isDesktop ? 'visible' : 'hidden' }}>
        {children}
      </div>
    </div>
  )
}
