// FitText - a number (an amount, a total) on ONE line that shrinks only when
// it doesn't fit its box, like Android's auto-sizing text views. Normal
// values keep their size; a long one ("$1,234,567.89" in a third of a small
// phone) gets smaller instead of breaking across lines ("$1,234,567 / .89") or
// running off the card.
//
// Measured before paint (no visible resize), and again when the box or the
// text changes size (ResizeObserver) - nothing runs while scrolling.
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'

export function FitText({ size, min, style, children }: {
  /** The normal font size (px) - never exceeded. */
  size: number
  /** The smallest it may get (px). */
  min: number
  /** Everything else about the text (weight, colour, letter spacing…). */
  style?: CSSProperties
  children: ReactNode
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  // Re-measure when the shown text changes - not on every render.
  const text = Array.isArray(children) ? children.join('') : String(children ?? '')
  const textRef = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const box = boxRef.current, span = textRef.current
    if (!box || !span) return
    const fit = () => {
      span.style.fontSize = `${size}px`
      const room = box.clientWidth, need = span.scrollWidth
      if (room > 0 && need > room) span.style.fontSize = `${Math.max(min, Math.floor(size * (room / need) * 10) / 10)}px`
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(fit)
    ro.observe(box)
    return () => ro.disconnect()
  }, [size, min, text])

  return (
    <div ref={boxRef} style={{ ...style, fontSize: size, whiteSpace: 'nowrap', minWidth: 0, maxWidth: '100%' }}>
      <span ref={textRef} style={{ display: 'inline-block', fontSize: size }}>{children}</span>
    </div>
  )
}
