import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

// Bridges a "flash" checkmark's measured position to a final success
// screen's own checkmark spot — used by both PaySendPage and ChatPage's
// in-chat payment flow (processing -> full-screen brand flash -> this
// travels the checkmark into place -> success screen's own elements drop
// in). Plain getBoundingClientRect + CSS transform, deliberately not
// Framer's layout/layoutId prop — that was tried first and produced zero
// visible motion in production (see PaySendPage's own history on this
// feature for the full story). Mounts already positioned/sized to exactly
// match `from` (no flash-of-wrong-position), then on the next frame
// animates via transform to exactly match `to`.
//
// transformOrigin is 'top left' to match the translate math below: with a
// top-left-anchored scale, the box's top-left corner stays fixed while
// scaling, so landing on the target only needs a direct corner-to-corner
// translate (`to.left - from.left`), not a center-based one. Using a
// center-based delta with a top-left origin was the actual bug behind an
// earlier version of this animation visibly drifting up-and-left before
// settling — the two must always agree.
export function TravelingCheckmark({ from, to }: { from: DOMRect; to: DOMRect }) {
  const elRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = elRef.current
    if (!el) return
    const scaleX = to.width / from.width
    const scaleY = to.height / from.height
    const dx = to.left - from.left
    const dy = to.top - from.top
    el.style.transform = 'translate(0px, 0px) scale(1, 1)'
    // Force layout so the starting (identity) transform is actually
    // committed before the animated one is applied, or both would
    // collapse into a single frame with no visible motion.
    void el.getBoundingClientRect()
    requestAnimationFrame(() => {
      el.style.transition = 'transform 0.5s cubic-bezier(0.2, 0.8, 0.2, 1)'
      el.style.transform = `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`
    })
  }, [from, to])

  // Portalled straight to <body> — `from`/`to` are viewport-relative
  // coordinates from getBoundingClientRect(), and `position: fixed` only
  // resolves against those coordinates if nothing between this element
  // and <body> establishes its own containing block. PageTransition's
  // motion.div (every route is wrapped in it, desktop included) animates
  // `y` via Framer Motion, which leaves a non-`none` `transform` on that
  // element even once settled at y:0 — and any `transform` other than
  // `none` makes an element a containing block for its `fixed` descendants
  // per spec. Nested under that, this element's "fixed" position was
  // actually being resolved against the motion.div's own box, not the
  // real viewport — invisible or badly mispositioned whenever that
  // ancestor didn't happen to exactly fill the viewport, which is exactly
  // the desktop swap layout (an extra scrollable column wrapping this).
  // Same root cause and same fix as Toast.tsx's off-center bug.
  return createPortal(
    <div ref={elRef} style={{
      position: 'fixed', zIndex: 1000,
      left: from.left, top: from.top, width: from.width, height: from.height,
      borderRadius: '50%', background: '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      transformOrigin: 'top left',
    }}>
      <svg width={from.width * 0.46} height={from.height * 0.46} viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </div>,
    document.body
  )
}
