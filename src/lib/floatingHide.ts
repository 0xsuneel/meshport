// Screens where nothing may float on top (19 Nov 2026): a passcode keypad.
// The admin's draggable mode switch sat over the "6" key, so tapping 6 hit
// the switch, never the keypad. Floating buttons hide while one is open.
import { useEffect, useSyncExternalStore } from 'react'

let open = 0
const listeners = new Set<() => void>()
const notify = () => listeners.forEach(l => l())

/** While `active`, floating buttons (useFloatingHidden) hide. */
export function useHideFloating(active: boolean): void {
  useEffect(() => {
    if (!active) return
    open += 1; notify()
    return () => { open = Math.max(0, open - 1); notify() }
  }, [active])
}

export function useFloatingHidden(): boolean {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l) } }, () => open > 0, () => false)
}
