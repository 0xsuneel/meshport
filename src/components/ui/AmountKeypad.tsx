/**
 * AmountKeypad - THE amount keypad, everywhere money is typed.
 * Mobile: half-sheet numeric keypad that slides up from the bottom on the
 * app's sheet motion (drag down, tap the light dim or Back to close).
 * `variant="inline"`: the same keys right in the page (chat Pay, Request).
 * Desktop: NOT a popup at all - renders as a plain in-flow card (no
 * backdrop, no fixed positioning) right where the caller places it, since
 * a physical keyboard + a live input is how real desktop apps (Binance,
 * Coinbase) do amount entry - the field is just always there, never
 * hidden behind a tap-to-reveal sheet. Same `value`/`onChange`/`onDone`
 * contract either way - callers don't change how they read/write state,
 * only how `open` gets set to true (see each call site).
 */
import { useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { SHEET_PANEL, SHEET_BACKDROP, LIGHT_DIM, DESKTOP_FADE_Y, DESKTOP_FADE_TRANSITION, DESKTOP_QUERY } from '@/lib/motion'
import { sheetDrag } from '@/lib/sheetDrag'
import { useBackLayer } from '@/lib/backLayers'
import { motion, AnimatePresence } from 'framer-motion'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { opensKeyboard } from '@/hooks/useKeyboardOpen'
import { amountFontSize } from '@/lib/amountFontSize'

// Same digit/decimal sanitizing handleKey already does one keystroke at a
// time (max one '.', capped at `decimals` typed decimal places - Max still
// injects more precision directly via onChange, bypassing this), just
// applied to a whole pasted/typed string at once for the desktop
// native-input branch.
// BUG FIX: this used to hardcode a 2-decimal cap regardless of token,
// which meant cirBTC (8 decimals) could never be typed finer than 0.01
// through this component at all -- silently showing/entering "0.00" for
// any real cirBTC balance. Callers now pass the right cap for their token
// (see the `decimals` prop below).
export function sanitizeAmountInput(raw: string, decimals: number): string {
  let cleaned = raw.replace(/[^\d.]/g, '')
  const firstDot = cleaned.indexOf('.')
  if (firstDot !== -1) cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '')
  const [intPart, decPart] = cleaned.split('.')
  if (decPart !== undefined) cleaned = intPart + '.' + decPart.slice(0, decimals)
  return cleaned
}

/** How many decimals an amount in this token can be typed with (on-chain
 *  precision): USDC/EURC 6, cirBTC 8. */
export function tokenDecimals(token = 'USDC'): number {
  return String(token).toUpperCase() === 'CIRBTC' ? 8 : 6
}

interface AmountKeypadProps {
  value: string
  onChange: (val: string) => void
  balance?: number
  token?: string
  onDone?: () => void
  /** Label for the primary action button. Defaults to 'Done' - pages that
   * use this keypad as their only amount-entry step (no separate Continue
   * button below) can pass something more specific, e.g. 'Review'. */
  doneLabel?: string
  /** Set to false on pages that already have their own quick-amount row
   * (e.g. Swap's 25%/50%/75%/Max buttons on the page itself) - otherwise
   * the keypad's Max button duplicates a control that already exists
   * elsewhere on the same screen. Defaults to true everywhere else. */
  showMax?: boolean
  /** Amount to hold back out of `balance` when computing what the Max
   * button fills in - i.e. the estimated network fee (plus any safety
   * buffer the caller wants) for sends where gas is paid out of the same
   * balance being sent. Leave unset/0 for tokens that don't pay gas out of
   * this balance (e.g. an ERC-20 whose gas is paid in a separate native
   * token) - Max then falls back to the full balance exactly as before.
   * This only affects what Max fills in; the displayed balance elsewhere
   * on the page is untouched. */
  feeReserve?: number
  /** Extra condition ANDed with the existing amount-validity check before
   * the Done/Confirm button is enabled. Defaults to true (no extra gate --
   * every existing caller keeps its current behavior). Added so a caller
   * that has its own async readiness condition (e.g. Multichain Claim's
   * fee estimate still loading) can block the button on THIS keypad's
   * mobile sheet the same way it already blocks its own desktop button,
   * instead of only validating the raw amount. */
  doneEnabled?: boolean
  open: boolean
  onClose?: () => void
  error?: string
  /** Decimal places that can be typed (default: the token's, tokenDecimals). */
  decimals?: number
  /** Keys that would take the amount above this are ignored. */
  maxValue?: number
  /** Whole numbers only (points): the "." key is blank. */
  allowDecimal?: boolean
  /** Most digits before the decimal point. */
  maxDigits?: number
  /** 'inline': the keys right in the page (always shown, no sheet). */
  variant?: 'sheet' | 'inline'
  /** Opened on a pre-filled amount: the first digit typed starts a new
   *  amount (480, then 5 → 5); backspace edits what's there. */
  replaceOnFirstKey?: boolean
  /** Phone / browser Back closes the sheet. Off by default: the amount is a
   *  step of a page that already handles Back itself (Pay, Transfer, …). */
  backClose?: boolean
}

const KEYS = ['1','2','3','4','5','6','7','8','9','.','0','del']

export function AmountKeypad({
  value,
  onChange,
  balance = 0,
  token = 'USDC',
  onDone,
  doneLabel = 'Done',
  showMax = true,
  feeReserve = 0,
  doneEnabled = true,
  open,
  onClose,
  error,
  decimals,
  maxValue,
  allowDecimal = true,
  maxDigits,
  variant = 'sheet',
  backClose = false,
  replaceOnFirstKey = false,
}: AmountKeypadProps) {
  // Desktop users type on a physical keyboard - the tap-grid below is a
  // mobile-only affordance. Same value/onChange contract either way.
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  // Short phones (iPhone SE, small Androids with the browser bars showing):
  // smaller keys so the sheet leaves room for the amount above it.
  const short = useMediaQuery('(max-height: 700px)')

  // Opening the keypad closes the phone's own keyboard. On iPhone, tapping
  // the amount box doesn't take focus away from a text field typed in just
  // before (e.g. the recipient address), so the system keyboard stayed up
  // over this keypad - the keys looked "hidden" and typing went into the
  // address field instead.
  useEffect(() => {
    if (!open || isDesktop) return
    const el = document.activeElement
    if (el instanceof HTMLElement && opensKeyboard(el)) el.blur()
  }, [open, isDesktop])

  // BUG FIX: previously hardcoded to 2 everywhere below, regardless of
  // `token` - see sanitizeAmountInput's own comment. cirBTC needs its full
  // 8 decimals to be typeable at all; USDC/EURC were bumped to 3 (from 2),
  // matching the same standard PaySendPage.tsx / ChatPage.tsx /
  // SwapPage.tsx used to use.
  //
  // FURTHER FIX: 3 decimals still wasn't enough - a real dust-size payment
  // (e.g. 0.000004 USDC, common in ChatPay/testnet demo amounts) couldn't
  // even be TYPED, since a 4th decimal digit was silently rejected here.
  // Now that every amount display in this app trims trailing zeros (see
  // formatAmount/trimTrailingZeros in lib/utils.ts), there's no longer a
  // downside to giving every token its full on-chain-realistic precision -
  // a normal "5" still displays as "5", not "5.00000000" - so the cap is
  // just 8 for everyone, same as cirBTC always had.
  // USDC/EURC have 6 decimals on-chain - an 8-decimal amount can't even be
  // sent - so they cap at 6; cirBTC keeps its full 8.
  const decimalCap = allowDecimal ? (decimals ?? tokenDecimals(token)) : 0
  const sheetOpen = open && variant === 'sheet' && !isDesktop
  // Phone / browser Back closes the keypad sheet where asked (backClose).
  useBackLayer(sheetOpen && backClose && !!onClose, () => onClose?.())

  // replaceOnFirstKey: armed each time the keypad opens.
  const fresh = useRef(false)
  useEffect(() => { if (open) fresh.current = replaceOnFirstKey }, [open, replaceOnFirstKey])

  const handleKey = (key: string) => {
    if (fresh.current) {
      fresh.current = false
      if (key !== 'del') { onChange(key === '.' ? (decimalCap ? '0.' : '') : key); return }
    }
    if (key === 'del') { onChange(value.slice(0, -1)); return }
    if (key === '.') {
      if (!decimalCap || value.includes('.')) return
      onChange((value || '0') + '.')
      return
    }
    if (value.includes('.') && value.split('.')[1].length >= decimalCap) return
    const next = value === '0' ? key : value + key
    if (maxDigits && next.split('.')[0].length > maxDigits) return
    if (maxValue !== undefined && parseFloat(next) > maxValue) return
    onChange(next)
  }

  // ── Hold-to-repeat delete ─────────────────────────────────────────────
  // Clearing a long amount one tap per character (e.g. deleting all of
  // "100.0000") was tedious. Holding the delete key now keeps deleting on
  // its own, like a real keyboard's backspace-repeat, instead of requiring
  // a tap for every single character.
  //
  // `value` is a controlled prop - during a hold, several deletes can fire
  // before the parent's re-render round-trip catches up, so a ref mirrors
  // the "live" in-progress value rather than reading the (potentially
  // stale) `value` prop on every tick.
  const liveValueRef = useRef(value)
  useEffect(() => { liveValueRef.current = value }, [value])

  const deleteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const deleteIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stepDelete = () => {
    const next = liveValueRef.current.slice(0, -1)
    liveValueRef.current = next
    onChange(next)
  }

  const clearDeleteTimers = () => {
    if (deleteTimeoutRef.current)  { clearTimeout(deleteTimeoutRef.current);  deleteTimeoutRef.current = null }
    if (deleteIntervalRef.current) { clearInterval(deleteIntervalRef.current); deleteIntervalRef.current = null }
  }

  const startDeleteHold = () => {
    clearDeleteTimers()
    // First character was already removed by the click/tap handler itself
    // (handleKey('del') below) - this just arms the repeat-on-hold that
    // kicks in if the press continues past a brief delay, so a normal
    // quick tap still behaves exactly like before (delete one character).
    deleteTimeoutRef.current = setTimeout(() => {
      deleteIntervalRef.current = setInterval(stepDelete, 70)
    }, 350)
  }

  const stopDeleteHold = () => clearDeleteTimers()

  useEffect(() => clearDeleteTimers, [])

  // Error / Max row - skipped entirely (not just left empty) when there's
  // neither an error nor a Max button to show, so pages that pass
  // showMax={false} (e.g. Multichain Transfer, which already has its own
  // inline Max button on the page) get that space back rather than an
  // empty div still taking up its margin. Shared between the desktop card
  // and the mobile sheet - same row, same behavior either way.
  const errorMaxRow = (error || (showMax && balance > 0)) && (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: error ? 'space-between' : 'flex-end', gap: 8, margin: '0 0 10px' }}>
      {error && <p role="alert" style={{ fontSize: 12, color: 'var(--danger)', margin: 0 }}>{error}</p>}
      {showMax && balance > 0 && (
        <button
          onClick={() => {
            // Raw balances often carry long floating-point tails
            // (e.g. "100.00000000" or "24.9700000001") - dumping
            // that straight into the amount field looked broken.
            // Regular tokens (USDC/EURC) round to at most 4 decimal
            // places and trim trailing zeros. cirBTC is the
            // exception: BTC amounts are commonly tiny fractions
            // like 0.00002365 - rounding those to 4 decimals would
            // collapse them to 0.0000 and lose the actual balance,
            // so it keeps full precision instead, only trimming
            // trailing zeros.
            // BUG FIX: USDC/EURC dust balances (e.g. 0.000004) have the
            // exact same problem at 4 decimals as cirBTC did at 4 - so
            // every token now keeps full 8-decimal precision here too,
            // matching decimalCap above. trimTrailingZeros-style
            // formatting (parseFloat().toString() below) already keeps
            // normal-sized balances looking clean either way.
            const decimals = decimalCap
            // Leave enough behind to cover the network fee so the
            // transaction doesn't fail for lack of gas. Tokens that
            // don't pay gas out of this same balance pass
            // feeReserve=0 (the default), which keeps the old
            // "fill in the whole balance" behavior untouched.
            const maxSendable = Math.max(0, balance - feeReserve)
            const trimmed = parseFloat(maxSendable.toFixed(decimals)).toString()
            onChange(trimmed)
          }}
          style={{
            padding: '5px 14px', borderRadius: 100, border: '1px solid color-mix(in srgb, var(--brand) 40%, transparent)',
            background: 'color-mix(in srgb, var(--brand) 12%, transparent)', color: 'var(--brand-text)', fontSize: 12, fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Max
        </button>
      )}
    </div>
  )

  // Done - gated on (balance - feeReserve), the same fee-safe ceiling Max
  // fills in above, not the raw balance. Otherwise typing the full balance
  // by hand (instead of tapping Max) would slip past this button with
  // nothing left for gas. Shared between desktop and mobile.
  const doneButton = onDone && (() => {
    const spendable = Math.max(0, balance - feeReserve)
    const canProceed = parseFloat(value) > 0 && parseFloat(value) <= spendable && doneEnabled
    return (
      <button
        onClick={onDone}
        disabled={!canProceed}
        style={{
          width: '100%', padding: short && !isDesktop ? '13px' : '15px', borderRadius: 16,
          border: 'none', fontSize: 15, fontWeight: 700, cursor: 'pointer',
          background: canProceed ? 'var(--brand)' : 'color-mix(in srgb, var(--text-primary) 12%, transparent)',
          color: canProceed ? '#FFFFFF' : 'var(--text-secondary)',
          opacity: canProceed ? 1 : 0.5,
          transition: 'all 0.15s',
        }}
      >
        {doneLabel}
      </button>
    )
  })()

  const keyGrid = (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: short ? 8 : 10, maxWidth: 320, margin: short ? '0 auto 10px' : '0 auto 14px' }}>
      {KEYS.map((key, i) => key === '.' && !decimalCap ? <span key={i} aria-hidden /> : (
        <button
          key={i}
          type="button"
          aria-label={key === 'del' ? 'Delete' : key === '.' ? 'Decimal point' : key}
          onClick={() => handleKey(key)}
          style={{
            height: short ? 46 : 56, borderRadius: 14, width: '100%',
            background: 'var(--surface)',
            border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', fontSize: key === '.' ? 28 : 24, fontWeight: 600, color: key === 'del' ? 'var(--text-secondary)' : 'var(--text-primary)',
          }}
          // Same key press as the PIN keypad (.mp-key in index.css).
          className="mp-key"
          onMouseDown={() => { if (key === 'del') startDeleteHold() }}
          onMouseUp={() => { if (key === 'del') stopDeleteHold() }}
          onMouseLeave={() => { if (key === 'del') stopDeleteHold() }}
          onTouchStart={() => { if (key === 'del') startDeleteHold() }}
          onTouchEnd={() => { if (key === 'del') stopDeleteHold() }}
          onTouchCancel={() => { if (key === 'del') stopDeleteHold() }}
        >
          {key === 'del'
            ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 4H8l-7 8 7 8h13a2 2 0 002-2V6a2 2 0 00-2-2z"/>
                <line x1="18" y1="9" x2="12" y2="15"/>
                <line x1="12" y1="9" x2="18" y2="15"/>
              </svg>
            : key}
        </button>
      ))}
    </div>
  )

  if (variant === 'inline') {
    return (
      <div data-amount-keypad-inline="">
        {errorMaxRow}
        {keyGrid}
        {doneButton}
      </div>
    )
  }

  if (isDesktop) {
    // No popup at all - a plain in-flow card, right where the caller
    // places it on the page. Fades/lifts in on mount instead of the
    // mobile slide-up, since there's no "sheet" to slide.
    return (
      <AnimatePresence>
        {open && (
          <motion.div
            key="amount-card"
            initial={{ opacity: 0, y: DESKTOP_FADE_Y }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={DESKTOP_FADE_TRANSITION}
            style={{
              background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 18,
              boxShadow: 'var(--shadow-1)', padding: '20px 22px',
            }}
          >
            {errorMaxRow}
            <div style={{ margin: '0 auto 14px', maxWidth: 320 }}>
              <input
                type="text"
                inputMode="decimal"
                autoFocus
                value={value}
                onChange={e => onChange(sanitizeAmountInput(e.target.value, decimalCap))}
                placeholder="0.00"
                style={{
                  width: '100%', height: 56, borderRadius: 14, padding: '0 16px', boxSizing: 'border-box',
                  background: 'var(--bg)', border: `1px solid ${error ? 'var(--danger)' : 'var(--border)'}`,
                  // BUG FIX: this was a fixed 28px regardless of how long
                  // the typed value got - a long cirBTC amount (up to 10+
                  // characters at 8 decimals) would overflow the box
                  // instead of shrinking to fit.
                  color: 'var(--text-primary)', fontSize: amountFontSize(value, 28), fontWeight: 700, textAlign: 'center',
                  fontVariantNumeric: 'tabular-nums', outline: 'none',
                }}
                aria-label={`Amount in ${token}`}
              />
            </div>
            {doneButton}
          </motion.div>
        )}
      </AnimatePresence>
    )
  }

  // Portalled to <body>: a page can then glide its form up above the sheet
  // with a transform (useKeypadLift) without that transform breaking the
  // sheet's fixed position.
  return createPortal(
    <AnimatePresence>
      {open && (
        [
          /* Subtle backdrop - just enough separation to feel like a sheet,
              without washing out the amount display above it (the one
              sheet with a light dim: the amount must stay readable). */
          <motion.div
            key="backdrop"
            {...SHEET_BACKDROP}
            onClick={onClose}
            style={{
              position: 'fixed', top: 0, bottom: 0, left: 0, right: 0,
              maxWidth: 448, margin: '0 auto',
              zIndex: 40,
              background: LIGHT_DIM,
            }}
          />,

          /* Half sheet */
          <motion.div
            key="sheet"
            data-amount-keypad-sheet=""
            {...(onClose ? sheetDrag('amount-keypad', onClose) : {})}
            {...SHEET_PANEL}
            style={{
              position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 50,
              maxWidth: 448, margin: '0 auto',
              background: 'var(--surface)',
              borderRadius: '24px 24px 0 0',
              borderTop: '1px solid var(--border)',
              boxShadow: 'var(--shadow-3)',
              padding: short ? '8px 20px calc(env(safe-area-inset-bottom, 0px) + 16px)' : '10px 24px 32px',
            }}
          >
            {/* Handle (the same grabber as every sheet) */}
            <div data-sheet-handle style={{ display: 'flex', justifyContent: 'center', padding: short ? '0 0 8px' : '2px 0 12px' }}>
              <div style={{ width: 38, height: 5, borderRadius: 3, background: 'var(--border)' }} />
            </div>

            {errorMaxRow}

            {keyGrid}

            {doneButton}
          </motion.div>,
        ]
      )}
    </AnimatePresence>,
    document.body,
  )
}

