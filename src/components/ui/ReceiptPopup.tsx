import { type ComponentProps, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { DesktopDialogFrame } from './DesktopDialogFrame'
import { SuccessReceipt } from './SuccessReceipt'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useBackLayer } from '@/lib/backLayers'
import { DESKTOP_QUERY, PAGE_TRANSITION } from '@/lib/motion'

// A record reopened from history: tapping any history card (Activity, Home,
// Swap history, Multichain hub, desktop history panels).
//   • Phone (18 Nov): a full page that slides in - the app's header with a
//     back arrow, the check and amount, the page's own sections (To / From),
//     the rows under "Details". Back (arrow or the phone's) closes it.
//   • Computer: the receipt card, centred over the page.
// Built from the stored record, so it opens fully revealed with no confetti;
// failed / still-processing records get red / amber.
type ReceiptProps = ComponentProps<typeof SuccessReceipt>

// React delivers a portal's events to its React ancestors, so a popup opened
// from a chat bubble would otherwise feed that bubble's swipe-to-reply and
// tap handlers. Stop them at the popup.
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()

// While a receipt is open, every backdrop-filter underneath (sticky page
// headers, cards, the bottom nav…) is switched off - see usePopupOpen.
// The popup's dim covers the page, so nothing visible is lost.

export function ReceiptPopup({ onClose, onPrimary, pageTitle = 'Transaction details', sections, pagePerson, pageRows, ...receipt }: Omit<ReceiptProps, 'onPrimary' | 'revealed'> & {
  onClose: () => void
  /** Main button action; defaults to closing (Done). */
  onPrimary?: () => void
  /** The page's header on a phone. */
  pageTitle?: string
  /** Extra sections on the phone page, under the amount (To / From). */
  sections?: ReactNode
  /** The phone page's top for a record with a person (their initial + tick). */
  pagePerson?: NonNullable<ReceiptProps['page']>['person']
  /** The phone page's Details rows (default: the receipt's rows). */
  pageRows?: NonNullable<ReceiptProps['page']>['rows']
}) {
  const desktop = useMediaQuery(DESKTOP_QUERY)
  if (!desktop) return <ReceiptPage onClose={onClose} onPrimary={onPrimary} pageTitle={pageTitle} sections={sections} person={pagePerson} rows={pageRows} receipt={receipt} />
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

function ReceiptPage({ onClose, onPrimary, pageTitle, sections, person, rows, receipt }: {
  onClose: () => void
  onPrimary?: () => void
  pageTitle: string
  sections?: ReactNode
  person?: NonNullable<ReceiptProps['page']>['person']
  rows?: NonNullable<ReceiptProps['page']>['rows']
  receipt: Omit<ReceiptProps, 'onPrimary' | 'revealed'>
}) {
  // The phone's Back closes the page, like the popup it replaces.
  useBackLayer(true, onClose)
  // A button only when there's something to do (e.g. "Open Recover") -
  // otherwise the back arrow is the way out.
  const hasAction = !!onPrimary && !!receipt.primaryLabel
  const actions = hasAction ? [{ label: receipt.primaryLabel!, onClick: onPrimary!, primary: true }] : undefined
  return createPortal(
    <motion.div
      role="dialog" aria-modal="true" aria-label={pageTitle}
      onMouseDown={stop} onTouchStart={stop}
      initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={PAGE_TRANSITION}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--bg)', display: 'flex', flexDirection: 'column', willChange: 'transform' }}>
      <SuccessReceipt
        celebrate={false}
        promo
        {...receipt}
        revealed
        onPrimary={onPrimary ?? onClose}
        actions={actions}
        page={{ title: pageTitle, onBack: onClose, sections, noDone: !hasAction, person, rows }}
        style={{ flex: 1, minHeight: 0, height: 'auto', ...receipt.style }}
      />
    </motion.div>,
    document.body,
  )
}
