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

/**
 * Replace every already-decoded <img> in `copy` (a clone of `orig`) with a
 * canvas holding the same pixels. A copied <img> decodes again and is blank
 * for the picture's first frames - avatars and token logos blinked out on the
 * old page as it slid away. A canvas paints at once. One-for-one, so the
 * clone's elements still line up with the original's by index.
 */
export function replaceClonedImages(orig: HTMLElement, copy: HTMLElement): void {
  const live = orig.querySelectorAll('img')
  const cloned = copy.querySelectorAll('img')
  cloned.forEach((c, i) => {
    const o = live[i]
    if (!o || !o.complete || o.naturalWidth === 0) return
    const r = o.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    try {
      const dpr = window.devicePixelRatio || 1
      const cv = document.createElement('canvas')
      cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr)
      // Same crop as the original's object-fit (avatars use cover).
      const fit = getComputedStyle(o).objectFit
      const iw = o.naturalWidth, ih = o.naturalHeight, W = cv.width, H = cv.height
      const ctx = cv.getContext('2d')
      if (fit === 'cover') {
        const k = Math.max(W / iw, H / ih), sw = W / k, sh = H / k
        ctx?.drawImage(o, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, W, H)
      } else if (fit === 'contain' || fit === 'scale-down') {
        const k = Math.min(W / iw, H / ih), dw = iw * k, dh = ih * k
        ctx?.drawImage(o, (W - dw) / 2, (H - dh) / 2, dw, dh)
      } else {
        ctx?.drawImage(o, 0, 0, W, H)
      }
      cv.className = c.className
      cv.setAttribute('style', c.getAttribute('style') ?? '')
      Object.assign(cv.style, { width: `${r.width}px`, height: `${r.height}px` })
      c.replaceWith(cv)
    } catch { /* tainted / not drawable - keep the copied <img> */ }
  })
}
