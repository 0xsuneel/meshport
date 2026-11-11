// ── The button that was just pressed ────────────────────────────────────────
// Some steps take a moment to be ready after a press (the wallet's passcode
// page loading and settling). Instead of opening a sheet that can't be used
// yet, the button that was pressed shows three dots until it is - whichever
// button it was, on any screen (index.css .mp-btn-wait).

let last: { el: HTMLElement; at: number } | null = null

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', (e) => {
    const el = (e.target as Element | null)?.closest?.('button, [role="button"]') as HTMLElement | null
    if (el) last = { el, at: Date.now() }
  }, { capture: true, passive: true })
}

/** Shows the waiting dots on the button pressed in the last few seconds. Returns how to end it. */
export function waitOnPressedButton(maxAgeMs = 8000): () => void {
  const b = last
  if (!b || Date.now() - b.at > maxAgeMs || !b.el.isConnected) return () => {}
  const el = b.el
  // The dots take the label's own colour (the label itself is hidden).
  try { el.style.setProperty('--mp-wait-color', getComputedStyle(el).color) } catch { /* default colour */ }
  el.classList.add('mp-btn-wait')
  el.setAttribute('aria-busy', 'true')
  return () => {
    el.classList.remove('mp-btn-wait')
    el.removeAttribute('aria-busy')
    el.style.removeProperty('--mp-wait-color')
  }
}
