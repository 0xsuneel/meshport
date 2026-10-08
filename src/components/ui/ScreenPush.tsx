import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { pushLook } from '@/lib/pushLook'
import { useReducedMotion } from 'framer-motion'

// Screens that follow one another inside one page (Pay: search → amount →
// review; Swap: form → review; Multichain Bring: form → processing → Track
// Progress). When `screenKey` changes, the new screen slides in from the
// right over a picture of the old one, which shifts left and dims — the same
// push, timing and curve as opening a page (PageTransition). Going back
// reverses it: the old screen slides off to the right, uncovering the new
// one as it comes back from the left.
//
// Both screens stay fully opaque the whole time — no cross-fade — so two
// screens are never seen through each other and nothing ever flashes empty.
// The children are never remounted; only what they render changes, so the
// caller's own enter/exit animations for these screens should be instant.
const OPEN_MS = 300
const BACK_MS = 250
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'
const PARALLAX = '-28%'

/** A frozen, non-interactive copy of what's on screen right now — without
 *  fixed-position overlays (sheets, dims) that happen to be inside it. The
 *  amount keypad is the exception: it's returned separately (`floats`) so it
 *  stays in the picture and slides away with the old screen, instead of
 *  vanishing the instant its Review/Done button is tapped. */
function pictureOf(el: HTMLElement): { node: HTMLElement; floats: HTMLElement[] } {
  const node = el.cloneNode(true) as HTMLElement
  const orig = el.querySelectorAll<HTMLElement>('*')
  const copy = node.querySelectorAll<HTMLElement>('*')
  const drop: HTMLElement[] = []
  const floats: HTMLElement[] = []
  for (let i = 0; i < orig.length && i < copy.length; i++) {
    const o = orig[i], c = copy[i]
    if (o.scrollTop) c.dataset.mpScrollTop = String(o.scrollTop)
    if (getComputedStyle(o).position === 'fixed') (o.hasAttribute('data-amount-keypad-sheet') ? floats : drop).push(c)
    if ((o instanceof HTMLInputElement || o instanceof HTMLTextAreaElement) && (c instanceof HTMLInputElement || c instanceof HTMLTextAreaElement)) c.value = o.value
    if (c.id) c.removeAttribute('id')
    if (c.hasAttribute('data-amount-keypad-sheet')) c.removeAttribute('data-amount-keypad-sheet')
  }
  drop.forEach(c => c.remove())
  floats.forEach(c => { c.remove(); c.style.position = 'absolute' })
  node.removeAttribute('id')
  return { node, floats }
}

export function ScreenPush({ screenKey, back = false, style, children }: {
  screenKey: string
  /** This change goes back (the screen being left slides off to the right). */
  back?: boolean
  style?: CSSProperties
  children: ReactNode
}) {
  const reduce = useReducedMotion()
  const hostRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef<HTMLDivElement>(null)
  const shown = useRef(screenKey)
  const snap = useRef<{ key: string; node: HTMLElement; floats: HTMLElement[] } | null>(null)
  const cleanup = useRef<(() => void) | null>(null)

  // About to change screens: picture the old one while it's still on screen
  // (render runs before React touches the DOM).
  if (!reduce && shown.current !== screenKey && snap.current?.key !== screenKey && liveRef.current) {
    try { snap.current = { key: screenKey, ...pictureOf(liveRef.current) } } catch { snap.current = null }
  }

  useLayoutEffect(() => {
    if (shown.current === screenKey) return
    shown.current = screenKey
    cleanup.current?.()
    const s = snap.current
    snap.current = null
    const host = hostRef.current, live = liveRef.current
    if (!s || s.key !== screenKey || !host || !live) return

    const opts: KeyframeAnimationOptions = { duration: back ? BACK_MS : OPEN_MS, easing: EASE, fill: 'both' }
    const layer = document.createElement('div')
    layer.setAttribute('aria-hidden', 'true')
    layer.className = 'mp-page-snapshot' // no replayed CSS animations in the picture
    Object.assign(layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden', background: 'var(--bg)' })
    Object.assign(s.node.style, { position: 'absolute', left: '0', right: '0', top: '0', minHeight: '100%' })
    layer.appendChild(s.node)
    s.floats.forEach(f => layer.appendChild(f)) // pinned to the bottom of the picture
    const look = pushLook()
    const veil = document.createElement('div')
    Object.assign(veil.style, { position: 'absolute', inset: '0', background: '#000', opacity: '0', pointerEvents: 'none' })
    // Front: the screen arriving (forward) or the one leaving (back).
    layer.style.zIndex = back ? '3' : '1'
    veil.style.zIndex = '2'
    host.appendChild(layer)
    host.appendChild(veil)
    s.node.querySelectorAll<HTMLElement>('[data-mp-scroll-top]').forEach(el => { el.scrollTop = Number(el.dataset.mpScrollTop) })
    const prev = { position: live.style.position, zIndex: live.style.zIndex, background: live.style.background, boxShadow: live.style.boxShadow }
    Object.assign(live.style, { position: 'relative', zIndex: back ? '1' : '3', background: 'var(--bg)' })
    ;(back ? layer : live).style.boxShadow = look.shadow

    const anims = back
      ? [
          layer.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(100%)' }], opts),
          live.animate([{ transform: `translateX(${PARALLAX})` }, { transform: 'translateX(0)' }], opts),
          veil.animate([{ opacity: look.dim }, { opacity: 0 }], opts),
        ]
      : [
          live.animate([{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }], opts),
          layer.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${PARALLAX})` }], opts),
          veil.animate([{ opacity: 0 }, { opacity: look.dim }], opts),
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
  }, [screenKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => () => cleanup.current?.(), [])

  return (
    <div ref={hostRef} style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflowX: 'clip', ...style }}>
      <div ref={liveRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>{children}</div>
    </div>
  )
}
