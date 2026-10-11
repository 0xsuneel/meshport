import { useLayoutEffect, type RefObject } from 'react'

// Focus a field when it appears - without the `autoFocus` attribute.
// On iPhone, `autoFocus` scrolls the field into view as it mounts, even while
// its page is still sliding in from off-screen (translateX(100%)): WebKit
// scrolls the app sideways to reach it and leaves the whole screen shifted
// half off the side. This focuses at the same moment (still inside the tap,
// so the phone keyboard may open) but never scrolls anything.
export function useAutoFocus(ref: RefObject<HTMLElement | null>, enabled = true) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!enabled || !el) return
    try { el.focus({ preventScroll: true }) } catch { el.focus() }
  }, [ref, enabled])
}
