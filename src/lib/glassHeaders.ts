// Every page's glass header (index.css, mp-glass-header) stays plain page
// colour until its page has scrolled: one listener for all scroll boxes marks
// the headers inside the box that scrolled (data-scrolled). Written straight
// to the element - no re-render on scroll. Installed once at start-up, so it
// covers every page, signed in or not.

let installed = false

export function installGlassHeaders(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  // Per scroll box: its headers, looked up again when one went away or (for
  // a box with none, e.g. a chat thread) at most once a second.
  const headersOf = new WeakMap<Element, { hs: HTMLElement[]; at: number }>()
  document.addEventListener('scroll', (e: Event) => {
    const box = e.target
    if (!(box instanceof HTMLElement)) return
    const now = performance.now()
    let c = headersOf.get(box)
    if (!c || c.hs.some(h => !h.isConnected) || (!c.hs.length && now - c.at > 1000)) {
      c = { hs: [...box.querySelectorAll<HTMLElement>('.mp-glass-header')], at: now }
      headersOf.set(box, c)
    }
    if (!c.hs.length) return
    const on = box.scrollTop > 0
    for (const h of c.hs) if (h.hasAttribute('data-scrolled') !== on) h.toggleAttribute('data-scrolled', on)
  }, { capture: true, passive: true })
}
