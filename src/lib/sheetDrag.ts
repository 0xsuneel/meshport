import type { PointerEvent as ReactPointerEvent } from 'react'
import { DragControls, type PanInfo, type Transition } from 'framer-motion'
import { projectMomentum } from './gesture'

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
// The last release that closed each sheet: its speed and how far the panel
// still had to go - sheetExit() times the close from it.
const flings = new Map<string, { v: number; remaining: number; at: number }>()
// The shared sheet curve's starting slope (cubic-bezier(0.32, 0.72, 0, 1):
// 0.72 / 0.32). A close lasting slope × distance / speed starts moving at
// exactly the finger's speed - no seam between the drag and the close.
const EXIT_SLOPE = 0.72 / 0.32
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

/**
 * A sheet's closing transition. Right after a flick closed it, the close
 * continues at the finger's speed (a fast flick closes fast, a slow pull
 * gently); otherwise the sheet's normal close.
 */
export function sheetExit(id: string, base: { y: string; transition: Transition }): { y: string; transition: Transition } {
  const f = flings.get(id)
  if (!f || Date.now() - f.at > 600 || f.v <= 0) return base
  const duration = Math.min(0.3, Math.max(0.12, (EXIT_SLOPE * f.remaining) / f.v))
  return { y: base.y, transition: { duration, ease: [0.32, 0.72, 0, 1] } }
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
    // Pulled up past its open position the sheet gives a little (rising
    // resistance) instead of stopping dead.
    dragElastic: { top: 0.06, bottom: 1 },
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
    onDragEnd: (e: unknown, info: PanInfo) => {
      // Where the pull would come to rest if it coasted: a quick short flick
      // closes, a slow pull needs to go further.
      const landing = info.offset.y + projectMomentum(info.velocity.y)
      if (info.offset.y > 90 || (landing > 120 && info.velocity.y > 0)) {
        const panel = ((e as Event)?.target as Element | null)?.closest?.('[data-sheet-drag]')
        const h = panel?.getBoundingClientRect().height ?? 600
        flings.set(id, { v: info.velocity.y, remaining: Math.max(0, h - info.offset.y), at: Date.now() })
        onClose()
      }
    },
  }
}
