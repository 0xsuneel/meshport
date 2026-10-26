// PinSheet - THE passcode step before money moves, everywhere (Pay, Swap,
// Transfer, Claim, Bulk Pay, chat Pay, P2P, Business, merchant refunds).
// Phone: the app's bottom sheet (ActionSheet) with the passcode keypad.
// Desktop: the authorize dialog (DesktopTransactionAuthDialog) - lock badge,
// amount and what it's for, then the keypad's typed input.
// The error shows in one place on both: under the title, in red, and the
// dots shake. With no passcode set, a plain confirm button stands in for the
// keypad, so it's still an explicit "are you sure" step.
import { type ReactNode } from 'react'
import { AnimatePresence } from 'framer-motion'
import { ActionSheet } from './ActionSheet'
import { DesktopTransactionAuthDialog } from './DesktopTransactionAuthDialog'
import { PinKeypad } from './PinKeypad'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DESKTOP_QUERY } from '@/lib/motion'
import type { BiometricVerb } from '@/lib/biometricWording'

export interface PinSheetProps {
  open: boolean
  onClose: () => void
  title: string
  /** What it's for ("Send $24.00 to ravi.arc"). */
  subtitle: ReactNode
  value: string
  onChange: (v: string) => void
  onComplete: (pin: string, viaBiometric?: boolean) => void
  /** Wrong passcode, or why it failed - replaces the subtitle, dots shake. */
  error?: string
  /** No passcode set: show this confirm button instead of the keypad. */
  fallbackConfirm?: { label: string; onConfirm: () => void }
  /** Above the title (chat Pay's review card, Bulk Pay's total). */
  header?: ReactNode
  /** Under the keypad ("Verifying…"). */
  footer?: ReactNode
  /** Tap on the dim / drag / Back can't close it (while it's sending). */
  locked?: boolean
  biometricAvailable?: boolean
  autoBiometric?: boolean
  /** What this flow does, for the fingerprint view: "Pay with Face ID",
   *  "Swap with fingerprint"... (default Confirm). */
  bioVerb?: BiometricVerb
  /** Phone: what it's for and how much, as a card under the title (in place
   *  of the subtitle), so it's in view before the fingerprint.
   *  `label` heads it: "Paying", "Swapping", "Sending to", "Claiming"... */
  card?: { label: string; name: string; detail?: string; amount: string; unit?: string }
  /** Inside a panel (the chat) instead of over the whole app. */
  inPanel?: boolean
  /** Phone / browser Back closes it (default). Off where the page already
   *  handles Back for this step itself. */
  backClose?: boolean
  id?: string
  /** Stacking order, to sit over a popup that stays open (e.g. 210 over a
   *  DesktopDialogFrame at 200). Default: the sheet's / dialog's own. */
  zIndex?: number
  // Desktop dialog
  amountLabel?: string
  placement?: 'center' | 'panel'
  panelWidth?: string
  anchor?: HTMLElement | null
  instantExit?: boolean
  /** It's closing because the next page is coming in over it (the passcode
   *  is right → processing): it leaves underneath that page - no slide down
   *  or fade on top of it. */
  leaveUnder?: boolean
}

export function PinSheet(p: PinSheetProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY)
  const close = p.locked ? () => {} : p.onClose
  const pad = p.fallbackConfirm ? (
    <button type="button" onClick={p.fallbackConfirm.onConfirm}
      className="w-full rounded-2xl py-4 text-[15px] font-bold text-white bg-brand active:scale-[0.98] transition-transform">
      {p.fallbackConfirm.label}
    </button>
  ) : (
    <PinKeypad value={p.value} onChange={p.onChange} length={6} error={!!p.error} shake={!!p.error}
      onComplete={p.onComplete} biometricAvailable={p.biometricAvailable} autoBiometric={p.autoBiometric} bioVerb={p.bioVerb} />
  )
  const said = p.error
    ? <span role="alert" className="text-danger">{p.error}</span>
    : p.subtitle

  if (desktop) {
    return (
      <AnimatePresence custom={!!p.leaveUnder}>
        {p.open && (
          <DesktopTransactionAuthDialog key={p.id ?? 'pin'} onClose={close} title={p.title} amountLabel={p.amountLabel} subLabel={said}
            placement={p.placement} panelWidth={p.panelWidth} anchor={p.anchor} instantExit={p.instantExit} backClose={p.backClose ?? true} zIndex={p.zIndex}>
            {p.header}
            {pad}
            {p.footer}
          </DesktopTransactionAuthDialog>
        )}
      </AnimatePresence>
    )
  }
  return (
    <ActionSheet open={p.open} onClose={close} isDesktop={false} id={p.id} fixed={!p.inPanel} backClose={p.backClose ?? true} zIndex={p.zIndex} leaveUnder={p.leaveUnder}>
      <div className="flex flex-col px-6 pt-2 pb-[max(28px,env(safe-area-inset-bottom))] overflow-y-auto">
        {p.header}
        <div className="text-center mb-7">
          <h2 className="text-lg font-bold text-text-primary">{p.title}</h2>
          {(!p.card || p.error) && <p className="text-[13px] mt-1.5 text-text-secondary">{said}</p>}
          {p.card && <SummaryCard {...p.card} />}
        </div>
        {pad}
        {p.footer}
      </div>
    </ActionSheet>
  )
}

function SummaryCard({ label, name, detail, amount, unit }: NonNullable<PinSheetProps['card']>) {
  return (
    <div className="mt-4 flex items-center gap-3 rounded-[18px] bg-bg px-4 py-3.5 text-left">
      <div className="w-11 h-11 rounded-full flex items-center justify-center shrink-0 text-[18px] font-extrabold text-brand-text"
        style={{ background: 'color-mix(in srgb, var(--brand) 16%, transparent)' }}>
        {name.trim().charAt(0).toUpperCase() || '?'}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] text-text-secondary">{label}</p>
        <p className="text-[16px] font-bold text-text-primary truncate">{name}</p>
        {detail && <p className="text-[13px] text-text-secondary truncate">{detail}</p>}
      </div>
      <div className="text-right shrink-0">
        <p className="text-[22px] font-extrabold tracking-[-0.5px] text-text-primary tabular-nums">{amount}</p>
        {unit && <p className="text-[13px] text-text-secondary">{unit}</p>}
      </div>
    </div>
  )
}
