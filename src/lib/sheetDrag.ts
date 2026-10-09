import type { PointerEvent as ReactPointerEvent } from 'react'
import { DragControls, type PanInfo } from 'framer-motion'

// Drag-down-to-close for bottom sheets, like every phone payment app.
//
// Spread onto a sheet's sliding panel (the motion.div with y: '100%' → 0):
//   <motion.div {...sheetDrag('pay-pin', close)} initial=… animate=… exit=…>
//
// Only a pull that starts on the sheet's top strip (grabber / title row,
// top ~72px) moves the sheet, and only while the content under the finger is
// scrolled to its top - so lists, inputs and buttons inside the sheet work
// exactly as before. A short, quick flick or a pull past ~90px closes it
// through the sheet's own close handler (the same one its backdrop uses);
// anything less springs back.
const ZONE = 72
const controls = new Map<string, DragControls>()
const bound = new WeakSet<HTMLElement>()
const INTERACTIVE = 'input, textarea, select, button, a, [contenteditable="true"], [role="slider"], [data-no-drag]'

function canDragFrom(panel: HTMLElement, target: EventTarget | null, clientY: number): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest(INTERACTIVE)) return false
  if (clientY - panel.getBoundingClientRect().top > ZONE && !target.closest('[data-sheet-handle]')) return false
  // Anything scrolled between the finger and the panel keeps its own scroll.
  for (let el: Element | null = target; el && el !== panel.parentElement; el = el.parentElement) {
    if ((el as HTMLElement).scrollTop > 0) return false
  }
  return true
}

export function sheetDrag(id: string, onClose: () => void) {
  let ctl = controls.get(id)
  if (!ctl) { ctl = new DragControls(); controls.set(id, ctl) }
  const dc = ctl
  return {
    drag: 'y' as const,
    dragListener: false,
    dragControls: dc,
    dragConstraints: { top: 0, bottom: 0 },
    dragElastic: { top: 0, bottom: 1 },
    dragMomentum: false,
    'data-sheet-drag': '',
    // Touch pulls on the top strip must not become a page scroll / pull-to-
    // refresh; this has to be a native, non-passive listener to be allowed
    // to cancel it.
    ref: (el: HTMLElement | null) => {
      if (!el || bound.has(el)) return
      bound.add(el)
      el.addEventListener('touchstart', (e: TouchEvent) => {
        if (e.touches.length === 1 && canDragFrom(el, e.target, e.touches[0].clientY)) e.preventDefault()
      }, { passive: false })
    },
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerType === 'mouse') return
      if (canDragFrom(e.currentTarget, e.target, e.clientY)) dc.start(e)
    },
    onDragEnd: (_: unknown, info: PanInfo) => {
      if (info.offset.y > 90 || (info.velocity.y > 500 && info.offset.y > 20)) onClose()
    },
  }
}
