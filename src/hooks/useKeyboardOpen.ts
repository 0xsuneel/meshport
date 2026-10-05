// True while the phone's on-screen keyboard is up — i.e. while a text field
// has focus. Detected from focus rather than from viewport sizes: this app's
// viewport uses interactive-widget=resizes-content, so on Android the whole
// layout viewport shrinks with the keyboard and a height comparison can't
// tell it's open. Pass enabled=false on desktop (physical keyboard).
import { useEffect, useState } from 'react'

const NO_KEYBOARD_TYPES = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image', 'hidden'])

function opensKeyboard(el: Element | null): boolean {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && el.inputMode !== 'none'
  if (el instanceof HTMLInputElement) return !el.readOnly && !NO_KEYBOARD_TYPES.has(el.type) && el.inputMode !== 'none'
  return (el as HTMLElement).isContentEditable === true
}

export function useKeyboardOpen(enabled = true): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!enabled) { setOpen(false); return }
    // Read after the focus change settles (during focusout, activeElement
    // is still in flux).
    let t = 0
    const update = () => { clearTimeout(t); t = window.setTimeout(() => setOpen(opensKeyboard(document.activeElement)), 0) }
    update()
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', update)
    return () => {
      clearTimeout(t)
      document.removeEventListener('focusin', update)
      document.removeEventListener('focusout', update)
    }
  }, [enabled])
  return open
}
