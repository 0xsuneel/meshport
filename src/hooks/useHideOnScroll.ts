// Hide-on-scroll for a list's search box (Chats, Activity): scrolling down
// the list tucks it away, scrolling back up (or reaching the top) brings it
// back. `keepVisible` holds it open while it's being used (focused / has text).
import { useEffect, useState, type RefObject } from 'react'

export function useHideOnScroll(ref: RefObject<HTMLElement>, keepVisible = false): boolean {
  const [hidden, setHidden] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let last = el.scrollTop
    let current = false
    let lockUntil = 0
    const onScroll = () => {
      const top = el.scrollTop
      const now = performance.now()
      const delta = top - last
      last = top
      // Ignore the scroll jitter caused by the box itself opening/closing.
      if (now < lockUntil) return
      let next = current
      if (top < 24) next = false
      else if (delta > 8) next = true
      // Near the bottom the list's height changes can nudge the scroll back —
      // only a real scroll up shows the box there.
      else if (delta < -8 && el.scrollHeight - el.clientHeight - top > 30) next = false
      if (next !== current) {
        current = next
        setHidden(next)
        lockUntil = now + 350
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [ref])
  return hidden && !keepVisible
}

/** Style for the box that collapses (height + fade). */
export const collapseStyle = (hidden: boolean, openHeight = 64): React.CSSProperties => ({
  maxHeight: hidden ? 0 : openHeight,
  opacity: hidden ? 0 : 1,
  overflow: 'hidden',
  transition: 'max-height 0.25s ease, opacity 0.2s ease, padding 0.25s ease, margin 0.25s ease',
})
