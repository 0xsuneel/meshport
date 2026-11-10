import { PUSH_OPEN_MS, PUSH_BACK_MS, PUSH_EASE_CSS, PUSH_PARALLAX, DESKTOP_FADE_KEYFRAMES, DESKTOP_FADE_MS } from '@/lib/motion'
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { pushLook } from '@/lib/pushLook'
import { replaceClonedFrames } from '@/lib/snapshotFrames'
import { useReducedMotion } from 'framer-motion'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DESKTOP_QUERY } from '@/lib/motion'

// Screens that follow one another inside one page (Pay: search → amount →
// review; Swap: form → review; Multichain Bring: form → processing → Track
// Progress). When `screenKey` changes, the new screen slides in from the
// right over a picture of the old one, which shifts left and dims - the same
// push, timing and curve as opening a page (PageTransition). Going back
// reverses it: the old screen slides off to the right, uncovering the new
// one as it comes back from the left.
//
// Both screens stay fully opaque the whole time - no cross-fade - so two
// screens are never seen through each other and nothing ever flashes empty.
// The children are never remounted; only what they render changes, so the
// caller's own enter/exit animations for these screens should be instant.
const OPEN_MS = PUSH_OPEN_MS
const BACK_MS = PUSH_BACK_MS
const EASE = PUSH_EASE_CSS
const PARALLAX = PUSH_PARALLAX

/** A frozen, non-interactive copy of what's on screen right now - without
 *  fixed-position overlays (dims, popups) that happen to be inside it. The
 *  amount keypad and bottom sheets (`data-push-keep`: the passcode sheet and
 *  its dim) are the exception: they're returned separately (`floats`) so they
 *  stay in the picture and slide away with the old screen, instead of
 *  vanishing the instant the step changes under them. */
function pictureOf(el: HTMLElement): { node: HTMLElement; floats: HTMLElement[] } {
  const node = el.cloneNode(true) as HTMLElement
  // Wallet frames (recovery phrase, private key, passkey) must not load again in the copy.
  replaceClonedFrames(el, node)
  const orig = el.querySelectorAll<HTMLElement>('*')
  const copy = node.querySelectorAll<HTMLElement>('*')
  const drop: HTMLElement[] = []
  const floats: HTMLElement[] = []
  const swaps: Array<[HTMLImageElement, HTMLCanvasElement]> = []
  for (let i = 0; i < orig.length && i < copy.length; i++) {
    const o = orig[i], c = copy[i]
    if (o.scrollTop) c.dataset.mpScrollTop = String(o.scrollTop)
    // A picture still sliding from the step before (a quick second change) is not part of this one.
    if (o.classList.contains('mp-page-snapshot') || o.hasAttribute('data-push-veil')) drop.push(c)
    else if (getComputedStyle(o).position === 'fixed') (o.hasAttribute('data-amount-keypad-sheet') || o.hasAttribute('data-push-keep') ? floats : drop).push(c)
    if ((o instanceof HTMLInputElement || o instanceof HTMLTextAreaElement) && (c instanceof HTMLInputElement || c instanceof HTMLTextAreaElement)) c.value = o.value
    // A copied <img> (token / chain logo, avatar) is blank for the picture's
    // first frame while it decodes again; draw the already-decoded original
    // into a canvas of the same size instead, which paints at once.
    if (o instanceof HTMLImageElement && c instanceof HTMLImageElement && o.complete && o.naturalWidth > 0) {
      const r = o.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) {
        try {
          const dpr = window.devicePixelRatio || 1
          const cv = document.createElement('canvas')
          cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr)
          // Same crop as the original's object-fit (avatars use cover).
          const fit = getComputedStyle(o).objectFit
          const iw = o.naturalWidth, ih = o.naturalHeight, W = cv.width, H = cv.height
          const ctx = cv.getContext('2d')
          if (fit === 'cover') {
            const k = Math.max(W / iw, H / ih), sw = W / k, sh = H / k
            ctx?.drawImage(o, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, W, H)
          } else if (fit === 'contain' || fit === 'scale-down') {
            const k = Math.min(W / iw, H / ih), dw = iw * k, dh = ih * k
            ctx?.drawImage(o, (W - dw) / 2, (H - dh) / 2, dw, dh)
          } else {
            ctx?.drawImage(o, 0, 0, W, H)
          }
          cv.className = c.className
          cv.setAttribute('style', c.getAttribute('style') ?? '')
          Object.assign(cv.style, { width: `${r.width}px`, height: `${r.height}px` })
          swaps.push([c, cv])
        } catch { /* keep the copied <img> */ }
      }
    }
    if (c.id) c.removeAttribute('id')
    if (c.hasAttribute('data-amount-keypad-sheet')) c.removeAttribute('data-amount-keypad-sheet')
    if (c.hasAttribute('data-push-keep')) c.removeAttribute('data-push-keep')
  }
  // The copy is not a live page: lookups for the open Hub page / guarded
  // flow (LeaveGuardHost takes the LAST match) must not find it.
  for (const el of [node, ...node.querySelectorAll<HTMLElement>('[data-hub-page], [data-leave-guard], [data-leave-ask]')]) {
    el.removeAttribute('data-hub-page'); el.removeAttribute('data-leave-guard'); el.removeAttribute('data-leave-ask')
  }
  swaps.forEach(([img, cv]) => img.replaceWith(cv))
  drop.forEach(c => c.remove())
  floats.forEach(c => { c.remove(); c.style.position = 'absolute' })
  node.removeAttribute('id')
  return { node, floats }
}

export function ScreenPush({ screenKey, back = false, style, pictureRoot, children }: {
  screenKey: string
  /** This change goes back (the screen being left slides off to the right). */
  back?: boolean
  style?: CSSProperties
  /** Selector of an ancestor (a fixed page such as a Hub page) to picture
   *  instead of only these steps: the old step then slides away together
   *  with that page's header and any open sheet - one piece, like a page
   *  push - even when the next step drops the header (Bring's processing). */
  pictureRoot?: string
  children: ReactNode
}) {
  const reduce = useReducedMotion()
  // Desktop: no phone push - the new step fades in place (see below).
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  const hostRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef<HTMLDivElement>(null)
  const shown = useRef(screenKey)
  const snap = useRef<{ key: string; node: HTMLElement; floats: HTMLElement[]; root: HTMLElement | null } | null>(null)
  const cleanup = useRef<(() => void) | null>(null)

  // About to change screens: picture the old one while it's still on screen
  // (render runs before React touches the DOM).
  if (!reduce && !isDesktop && shown.current !== screenKey && snap.current?.key !== screenKey && liveRef.current) {
    const root = pictureRoot ? liveRef.current.closest<HTMLElement>(pictureRoot) : null
    try { snap.current = { key: screenKey, ...pictureOf(root ?? liveRef.current), root } } catch { snap.current = null }
  }

  useLayoutEffect(() => {
    if (shown.current === screenKey) return
    shown.current = screenKey
    cleanup.current?.()
    const s = snap.current
    snap.current = null
    const host = hostRef.current, live = liveRef.current
    if (isDesktop && !reduce && live) {
      live.animate(DESKTOP_FADE_KEYFRAMES, { duration: DESKTOP_FADE_MS, easing: EASE })
      return
    }
    if (!s || s.key !== screenKey || !host || !live) return

    const opts: KeyframeAnimationOptions = { duration: back ? BACK_MS : OPEN_MS, easing: EASE, fill: 'both' }
    const layer = document.createElement('div')
    layer.setAttribute('aria-hidden', 'true')
    layer.className = 'mp-page-snapshot' // no replayed CSS animations in the picture
    Object.assign(layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden', background: 'var(--bg)' })
    // The picture of a whole page (pictureRoot) is laid over that page, which
    // stays where it is however its header / steps re-lay out under it.
    const stage = s.root?.isConnected ? s.root : host
    Object.assign(s.node.style, s.root
      ? { position: 'absolute', inset: '0', margin: '0', maxWidth: 'none', transform: 'none', zIndex: 'auto', boxShadow: 'none', willChange: 'auto' }
      : { position: 'absolute', left: '0', right: '0', top: '0', minHeight: '100%' })
    layer.appendChild(s.node)
    s.floats.forEach(f => layer.appendChild(f)) // pinned to the bottom of the picture
    const look = pushLook()
    const veil = document.createElement('div')
    veil.setAttribute('data-push-veil', '')
    Object.assign(veil.style, { position: 'absolute', inset: '0', background: '#000', opacity: '0', pointerEvents: 'none' })
    // Front: the screen arriving (forward) or the one leaving (back).
    layer.style.zIndex = back ? '3' : '1'
    veil.style.zIndex = '2'
    stage.appendChild(layer)
    stage.appendChild(veil)
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
