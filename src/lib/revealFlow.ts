// Scrolls a flow's own top edge up to the top of the screen, e.g. when the
// Multichain Hub's inline Transfer / Bring flow switches to its processing
// view: that view sits below the Hub's balance card and tabs, so without
// this the person would have to scroll to see the progress and buttons.
// Works on whichever ancestor actually scrolls, and stops below a sticky
// header marked with `data-scroll-header` (the Hub's title bar) while it's pinned.
export function revealFlow(el: HTMLElement | null) {
  if (!el) return
  // Already on screen in its own full page (Hub on a phone) - nothing to scroll.
  if (el.closest('[data-hub-page]')) return
  // Two frames: lets the Hub re-render its title bar (unpinned) first.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    // A container marked `data-flow-scroller` wins even while its scrolling
    // is locked (overflow hidden) - it can still be scrolled from code.
    let scroller: HTMLElement | null = el.closest<HTMLElement>('[data-flow-scroller]') ?? el.parentElement
    while (scroller && scroller !== document.body && !scroller.hasAttribute('data-flow-scroller')) {
      const oy = getComputedStyle(scroller).overflowY
      if ((oy === 'auto' || oy === 'scroll') && scroller.scrollHeight > scroller.clientHeight) break
      scroller = scroller.parentElement
    }
    const page = !scroller || scroller === document.body
    const target = page ? (document.scrollingElement as HTMLElement | null) : scroller
    if (!target) return
    const header = page ? null : target.querySelector<HTMLElement>('[data-scroll-header]')
    const headerH = header && getComputedStyle(header).position === 'sticky' ? header.getBoundingClientRect().height : 0
    const scrollerTop = page ? 0 : target.getBoundingClientRect().top
    const delta = el.getBoundingClientRect().top - scrollerTop - headerH
    if (Math.abs(delta) > 2) target.scrollBy({ top: delta, behavior: 'smooth' })
  }))
}
