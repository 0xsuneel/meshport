import { useEffect, type ComponentProps } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { DIALOG_BACKDROP, DIALOG_CARD } from '@/lib/motion'
import { SuccessReceipt } from './SuccessReceipt'

// The success screen, reopened from history: tapping any history card
// (Activity, Home, Swap history, Multichain hub, desktop history panels)
// shows the same receipt card a live payment ends on, centred over the page.
// Built from the stored record, so it opens fully revealed with no confetti;
// failed / still-processing records get the receipt's red / amber header.
type ReceiptProps = ComponentProps<typeof SuccessReceipt>

// React delivers a portal's events to its React ancestors, so a popup opened
// from a chat bubble would otherwise feed that bubble's swipe-to-reply and
// tap handlers. Stop them at the popup.
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()

// While a receipt is open, every backdrop-filter underneath (sticky page
// headers, cards, the bottom nav…) is switched off via a class on <html>
// (see `html.receipt-open` in index.css). Android Chrome re-runs each of those
// blurs on every frame the popup's pop-in spring animates over them, which
// showed up as the whole screen flickering when a history card was tapped.
// The popup's own 68% dim covers the page, so nothing visible is lost.
// A counter keeps this correct if two receipts are ever mounted at once.
let openReceipts = 0

export function ReceiptPopup({ onClose, onPrimary, ...receipt }: Omit<ReceiptProps, 'onPrimary' | 'revealed'> & {
  onClose: () => void
  /** Main button action; defaults to closing (Done). */
  onPrimary?: () => void
}) {
  useEffect(() => {
    openReceipts += 1
    document.documentElement.classList.add('receipt-open')
    return () => {
      openReceipts = Math.max(0, openReceipts - 1)
      if (openReceipts === 0) document.documentElement.classList.remove('receipt-open')
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <motion.div
      initial={DIALOG_BACKDROP.initial} animate={DIALOG_BACKDROP.animate} transition={DIALOG_BACKDROP.transition}
      onClick={e => { e.stopPropagation(); onClose() }}
      onMouseDown={stop} onMouseUp={stop} onTouchStart={stop} onTouchMove={stop} onTouchEnd={stop} onTouchCancel={stop}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, // A plain dim, no backdrop blur: Android Chrome re-blurs every frame
        // anything underneath animates (spinners, the chain scanner, live
        // lists), which made the popup flicker.
        background: 'rgba(0,0,0,0.68)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px',
      }}>
      <motion.div
        initial={DIALOG_CARD.initial} animate={DIALOG_CARD.animate} transition={DIALOG_CARD.transition}
        onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label={receipt.title}
        style={{ width: '100%', maxWidth: 420, maxHeight: '100%', display: 'flex', flexDirection: 'column', borderRadius: 30, overflow: 'hidden', willChange: 'transform, opacity', backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden' }}>
        <SuccessReceipt
          celebrate={false}
          stamp="History"
          {...receipt}
          revealed
          onPrimary={onPrimary ?? onClose}
          style={{ flex: 1, minHeight: 0, height: 'auto', padding: 0, background: 'transparent', ...receipt.style }}
        />
      </motion.div>
    </motion.div>,
    document.body,
  )
}
