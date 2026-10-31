// lib/snapshotFrames.ts
//
// The page / screen slide "pictures" (PageTransition, ScreenPush) are DOM
// clones. A cloned <iframe> is a brand-new frame that loads its src again:
// for the wallet's reveal / passkey frames that re-opens a one-time link (it
// shows "This link has expired" mid-slide) and flashes blank while it loads.
// Swap each cloned frame for a plain box of the same size instead - the
// frame's pixels are cross-origin, so they can't be pictured anyway.

/** Replace every iframe in `copy` (a clone of `orig`) with a same-size placeholder. */
export function replaceClonedFrames(orig: HTMLElement, copy: HTMLElement): void {
  const live = orig.querySelectorAll('iframe')
  const cloned = copy.querySelectorAll('iframe')
  cloned.forEach((c, i) => {
    const o = live[i]
    const box = document.createElement('div')
    box.className = c.className
    box.setAttribute('style', c.getAttribute('style') ?? '')
    const r = o?.getBoundingClientRect()
    if (r && r.width > 0 && r.height > 0) Object.assign(box.style, { width: `${r.width}px`, height: `${r.height}px` })
    Object.assign(box.style, { background: 'var(--surface)', opacity: '1' })
    c.replaceWith(box)
  })
}
