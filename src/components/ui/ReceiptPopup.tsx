import { type ComponentProps } from 'react'
import { DesktopDialogFrame } from './DesktopDialogFrame'
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
// headers, cards, the bottom nav…) is switched off - see usePopupOpen.
// The popup's dim covers the page, so nothing visible is lost.

export function ReceiptPopup({ onClose, onPrimary, ...receipt }: Omit<ReceiptProps, 'onPrimary' | 'revealed'> & {
  onClose: () => void
  /** Main button action; defaults to closing (Done). */
  onPrimary?: () => void
}) {
  // The app's one centred popup (Esc, Back, tap outside), with the receipt
  // drawing its own card.
  return (
    <DesktopDialogFrame onClose={onClose} maxWidth={420} zIndex={1000} bare>
      <div onMouseDown={stop} onTouchStart={stop} aria-label={receipt.title}
        style={{ display: 'flex', flexDirection: 'column', borderRadius: 30, overflow: 'hidden' }}>
        <SuccessReceipt
          celebrate={false}
          stamp="History"
          {...receipt}
          revealed
          onPrimary={onPrimary ?? onClose}
          style={{ flex: 1, minHeight: 0, height: 'auto', padding: 0, background: 'transparent', ...receipt.style }}
        />
      </div>
    </DesktopDialogFrame>
  )
}
