// iPhone zooms the whole page in when a text field under 16px gets focus,
// and does not zoom back out: the page slides sideways and up and every
// tap after that lands on a shifted layout. On touch screens, the moment a
// finger lands on a smaller field (before it focuses, which is when iOS
// decides to zoom), it is raised to 16px. Larger fields (the amount
// figures) are never touched, and zoom itself stays enabled.
const MIN = 16

function guard(e: Event) {
  const t = e.target
  if (!(t instanceof Element)) return
  const field = t.closest('input, textarea, select')
  if (!(field instanceof HTMLElement)) return
  if (field instanceof HTMLInputElement && /^(checkbox|radio|range|file|button|submit|color|hidden)$/.test(field.type)) return
  if (parseFloat(getComputedStyle(field).fontSize) < MIN) field.style.fontSize = `${MIN}px`
}

if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) {
  window.addEventListener('pointerdown', guard, { capture: true, passive: true })
}

export {}
