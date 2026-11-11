// PinSheet - THE passcode step before money moves, everywhere (Pay, Swap,
// Transfer, Claim, Bulk Pay, chat Pay, P2P, Business, merchant refunds).
// Phone: the app's bottom sheet (ActionSheet) with the passcode keypad.
// Desktop: the authorize dialog (DesktopTransactionAuthDialog) - lock badge,
// amount and what it's for, then the keypad's typed input.
// The error shows in one place on both: under the title, in red, and the
// dots shake. With no passcode set, a plain confirm button stands in for the
// keypad, so it's still an explicit "are you sure" step.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence } from 'framer-motion'
import { WalletConfirmFrame, type WalletConfirmRequest } from '@/components/wallet/WalletConfirmFrame'
import { walletConfirmAddress } from '@/lib/walletConfirm'
import type { ConfirmIntent, ConfirmRequest, ConfirmScope, ConfirmSummary } from '@/wallet/protocol'
import { ActionSheet } from './ActionSheet'
import { waitOnPressedButton } from '@/lib/pressedButton'
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
  /**
   * Money moves: the passcode is typed in the wallet's own page instead of
   * this keypad (lib/walletConfirm), for wallets kept in the wallet frame.
   * What the wallet binds the approval to, read by the wallet itself:
   * `intent`, the exact transaction (Pay) - signed once; `scope`, a spend
   * limit (lib/walletConfirm spendScope) for the next 2 minutes; `request`,
   * one exact signature request. With none of them (an amount not known
   * yet) this keypad shows, and each signature is confirmed on its own.
   * Once approved, onChange / onComplete get a token in place of the
   * passcode, which the passcode checks accept.
   */
  walletConfirm?: { intent?: () => Promise<ConfirmIntent | null>; scope?: ConfirmScope | null; request?: ConfirmRequest | null; summary?: ConfirmSummary }
}

export function PinSheet(p: PinSheetProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY)
  const close = p.locked ? () => {} : p.onClose

  // ── In the wallet (walletConfirm) ──
  // A fresh confirmation each time the sheet opens, and again when the screen
  // clears the token (its send failed and it asks again).
  const [attempt, setAttempt] = useState(0)
  const [keypadOnly, setKeypadOnly] = useState(false)
  // The wallet's page is ready and has settled (WalletConfirmFrame): until
  // then the sheet is laid out but not shown, and the pressed button waits.
  // Per opening: "usable" from the last time the sheet was open never counts
  // for the next one - not even for its first frame (it used to flash the
  // whole sheet, then hide it, on a reopen).
  const openings = useRef(0)
  const wasOpen = useRef(false)
  if (p.open && !wasOpen.current) openings.current++
  wasOpen.current = p.open
  const opening = openings.current
  const [usableFor, setUsableFor] = useState(-1)
  const usable = usableFor === opening
  const setUsable = (v: boolean) => setUsableFor(v ? opening : -1)
  const pending = useRef<{ token: string; via: boolean } | null>(null)
  const lastValue = useRef(p.value)
  useEffect(() => { if (p.open) { setAttempt(a => a + 1); setKeypadOnly(false) } }, [p.open])
  useEffect(() => {
    const was = lastValue.current
    lastValue.current = p.value
    if (p.open && was.startsWith('wallet-confirmed:') && !p.value) setAttempt(a => a + 1)
    // onComplete from the render that has the token in the screen's state
    // (its handler reads its own passcode state, not the argument).
    if (pending.current && p.value === pending.current.token) {
      const { token, via } = pending.current
      pending.current = null
      p.onComplete(token, via)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.value, p.open])
  const wc = p.walletConfirm
  const inWallet = !!wc && !!(wc.intent || wc.scope || wc.request) && !p.fallbackConfirm && !keypadOnly && !!walletConfirmAddress()
  const subtitleText = typeof p.subtitle === 'string' ? p.subtitle : undefined
  const request: WalletConfirmRequest | null = inWallet ? {
    intent: wc!.intent, scope: wc!.scope, request: wc!.request,
    summary: wc!.summary ? wc!.summary
      : p.card
      ? { label: p.card.label, name: p.card.name, detail: p.card.detail, amount: p.card.amount, unit: p.card.unit }
      : { label: p.title, name: subtitleText || p.title, amount: p.amountLabel },
  } : null
  // Only while open: a closed sheet starts no confirmation.
  const walletPad = request && (p.open
    ? <WalletConfirmFrame key={attempt} request={request}
        onUnavailable={() => setKeypadOnly(true)}
        onUsable={() => setUsable(true)}
        onApproved={(token, via) => { pending.current = { token, via }; p.onChange(token) }} />
    : <div className="h-[480px]" aria-hidden />)

  // Phone: the sheet with the wallet's page appears in place once the page
  // can take touches - a sheet that slid up had dead keys for half a second
  // (ActionSheet inPlace). Meanwhile the button that was pressed shows three
  // dots. Never held for long: shown anyway after 4 s.
  const held = !!walletPad && p.open && !usable && !desktop
  const openedInPlace = useRef(false)
  if (!p.open) openedInPlace.current = false
  else if (walletPad) openedInPlace.current = true
  const inPlace = openedInPlace.current
  useEffect(() => {
    if (!held) return
    const end = waitOnPressedButton()
    const t = setTimeout(() => setUsable(true), 4000)
    return () => { end(); clearTimeout(t) }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- setUsable is for this opening, read when the effect starts
  }, [held])

  const pad = walletPad ? walletPad : p.fallbackConfirm ? (
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
    <ActionSheet open={p.open} onClose={close} isDesktop={false} id={p.id} fixed={!p.inPanel} backClose={p.backClose ?? true} zIndex={p.zIndex} leaveUnder={p.leaveUnder}
      inPlace={inPlace} held={held}>
      <div className="flex flex-col px-6 pt-2 pb-[max(28px,env(safe-area-inset-bottom))] overflow-y-auto">
        {p.header}
        {/* With the wallet's page, its card sits 16px under the title (as the
            card did here) and the page keeps its own space above the dots. */}
        <div className={`text-center ${walletPad && !p.error ? 'mb-4' : 'mb-7'}`}>
          <h2 className="text-lg font-bold text-text-primary">{p.title}</h2>
          {(!p.card || p.error) && (!walletPad || p.error) && <p className="text-[13px] mt-1.5 text-text-secondary">{said}</p>}
          {p.card && !walletPad && <SummaryCard {...p.card} />}
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
