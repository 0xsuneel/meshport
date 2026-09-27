// Lifts an amount box above the on-screen AmountKeypad while it's open, and
// back down when it closes — moving together with the keypad sheet (same
// spring), as one smooth glide.
//
// It moves the form with a transform instead of scrolling the page: a
// transform runs on the GPU and never changes layout, so there's no spacer
// to add / remove, no second correction pass and no scroll fighting the
// sheet's animation — the causes of the old flicker.
//
// Usage:
//   const lift = useKeypadLift(open, amountBoxRef, !isDesktop)
//   <motion.div animate={{ y: -lift }} transition={KEYPAD_SPRING}> …form… </motion.div>
// Keep the keypad itself OUTSIDE the moved element (a transformed parent
// would break its fixed positioning).
import { useEffect, useRef, useState, type RefObject } from 'react'

import { SHEET_SPRING } from '@/lib/motion'
/** The keypad sheet's own spring (the shared bottom-sheet spring). */
export const KEYPAD_SPRING = SHEET_SPRING

const GAP = 16

// The current lift, shared: a page wrapping the form (the Multichain Hub's
// balance card + tabs) moves its own part by the same amount, so everything
// above the amount glides up together as one screen.
let shared = 0
const listeners = new Set<(n: number) => void>()
function publish(n: number) { if (n === shared) return; shared = n; listeners.forEach(f => f(n)) }
/** The lift currently applied by an open amount keypad (0 when closed). */
export function useSharedKeypadLift(): number {
  const [v, setV] = useState(shared)
  useEffect(() => { listeners.add(setV); setV(shared); return () => { listeners.delete(setV) } }, [])
  return v
}

export function useKeypadLift(open: boolean, boxRef: RefObject<HTMLElement | null>, enabled = true): number {
  const [lift, setLift] = useState(0)
  const liftRef = useRef(0)
  useEffect(() => {
    if (!enabled || !open) { liftRef.current = 0; setLift(0); publish(0); return }
    let raf = 0
    let tries = 0
    const measure = () => {
      const box = boxRef.current
      const sheet = document.querySelector<HTMLElement>('[data-amount-keypad-sheet]')
      if (!box || !sheet) { if (++tries < 20) raf = requestAnimationFrame(measure); return }
      // offsetHeight is the sheet's final size even while it's sliding in.
      const sheetH = sheet.offsetHeight
      const viewH = Math.min(window.visualViewport?.height ?? window.innerHeight, window.innerHeight)
      // Where the box sits un-lifted (undo any lift already applied).
      const bottom = box.getBoundingClientRect().bottom + liftRef.current
      const need = Math.max(0, Math.round(bottom - (viewH - sheetH - GAP)))
      liftRef.current = need
      setLift(need)
      publish(need)
    }
    raf = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(raf)
  }, [open, enabled, boxRef])
  useEffect(() => () => publish(0), [])
  return lift
}
