/**
 * AmountKeypad — mobile: half-sheet numeric keypad that slides up from
 * bottom, subtle backdrop blur so background stays visible.
 * Desktop: NOT a popup at all — renders as a plain in-flow card (no
 * backdrop, no fixed positioning) right where the caller places it, since
 * a physical keyboard + a live input is how real desktop apps (Binance,
 * Coinbase) do amount entry — the field is just always there, never
 * hidden behind a tap-to-reveal sheet. Same `value`/`onChange`/`onDone`
 * contract either way — callers don't change how they read/write state,
 * only how `open` gets set to true (see each call site).
 */
import { useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { amountFontSize } from '@/lib/amountFontSize'

// Same digit/decimal sanitizing handleKey already does one keystroke at a
// time (max one '.', capped at `decimals` typed decimal places — Max still
// injects more precision directly via onChange, bypassing this), just
// applied to a whole pasted/typed string at once for the desktop
// native-input branch.
// BUG FIX: this used to hardcode a 2-decimal cap regardless of token,
// which meant cirBTC (8 decimals) could never be typed finer than 0.01
// through this component at all -- silently showing/entering "0.00" for
// any real cirBTC balance. Callers now pass the right cap for their token
// (see the `decimals` prop below).
function sanitizeAmountInput(raw: string, decimals: number): string {
  let cleaned = raw.replace(/[^\d.]/g, '')
  const firstDot = cleaned.indexOf('.')
  if (firstDot !== -1) cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '')
  const [intPart, decPart] = cleaned.split('.')
  if (decPart !== undefined) cleaned = intPart + '.' + decPart.slice(0, decimals)
  return cleaned
}

interface AmountKeypadProps {
  value: string
  onChange: (val: string) => void
  balance?: number
  token?: string
  quickAmounts?: number[]
  onDone?: () => void
  /** Label for the primary action button. Defaults to 'Done' — pages that
   * use this keypad as their only amount-entry step (no separate Continue
   * button below) can pass something more specific, e.g. 'Review'. */
  doneLabel?: string
  /** Set to false on pages that already have their own quick-amount row
   * (e.g. Swap's 25%/50%/75%/Max buttons on the page itself) — otherwise
   * the keypad's Max button duplicates a control that already exists
   * elsewhere on the same screen. Defaults to true everywhere else. */
  showMax?: boolean
  /** Amount to hold back out of `balance` when computing what the Max
   * button fills in — i.e. the estimated network fee (plus any safety
   * buffer the caller wants) for sends where gas is paid out of the same
   * balance being sent. Leave unset/0 for tokens that don't pay gas out of
   * this balance (e.g. an ERC-20 whose gas is paid in a separate native
   * token) — Max then falls back to the full balance exactly as before.
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
}

const KEYS = ['1','2','3','4','5','6','7','8','9','.','0','del']

export function AmountKeypad({
  value,
  onChange,
  balance = 0,
  token = 'USDC',
  quickAmounts = [10, 20, 50, 100],
  onDone,
  doneLabel = 'Done',
  showMax = true,
  feeReserve = 0,
  doneEnabled = true,
  open,
  onClose,
  error,
}: AmountKeypadProps) {
  // Desktop users type on a physical keyboard — the tap-grid below is a
  // mobile-only affordance. Same value/onChange contract either way.
  const isDesktop = useMediaQuery('(min-width: 980px)')

  // BUG FIX: previously hardcoded to 2 everywhere below, regardless of
  // `token` — see sanitizeAmountInput's own comment. cirBTC needs its full
  // 8 decimals to be typeable at all; USDC/EURC were bumped to 3 (from 2),
  // matching the same standard PaySendPage.tsx / ChatPage.tsx /
  // SwapPage.tsx used to use.
  //
  // FURTHER FIX: 3 decimals still wasn't enough — a real dust-size payment
  // (e.g. 0.000004 USDC, common in ChatPay/testnet demo amounts) couldn't
  // even be TYPED, since a 4th decimal digit was silently rejected here.
  // Now that every amount display in this app trims trailing zeros (see
  // formatAmount/trimTrailingZeros in lib/utils.ts), there's no longer a
  // downside to giving every token its full on-chain-realistic precision —
  // a normal "5" still displays as "5", not "5.00000000" — so the cap is
  // just 8 for everyone, same as cirBTC always had.
  const decimalCap = 8

  const handleKey = (key: string) => {
    if (key === 'del') { onChange(value.slice(0, -1)); return }
    if (key === '.') {
      if (value.includes('.')) return
      onChange((value || '0') + '.')
      return
    }
    if (value.includes('.') && value.split('.')[1].length >= decimalCap) return
    if (value === '0') onChange(key)
    else onChange(value + key)
  }

  // ── Hold-to-repeat delete ─────────────────────────────────────────────
  // Clearing a long amount one tap per character (e.g. deleting all of
  // "100.0000") was tedious. Holding the delete key now keeps deleting on
  // its own, like a real keyboard's backspace-repeat, instead of requiring
  // a tap for every single character.
  //
  // `value` is a controlled prop — during a hold, several deletes can fire
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
    // (handleKey('del') below) — this just arms the repeat-on-hold that
    // kicks in if the press continues past a brief delay, so a normal
    // quick tap still behaves exactly like before (delete one character).
    deleteTimeoutRef.current = setTimeout(() => {
      deleteIntervalRef.current = setInterval(stepDelete, 70)
    }, 350)
  }

  const stopDeleteHold = () => clearDeleteTimers()

  useEffect(() => clearDeleteTimers, [])

  // Error / Max row — skipped entirely (not just left empty) when there's
  // neither an error nor a Max button to show, so pages that pass
  // showMax={false} (e.g. Multichain Transfer, which already has its own
  // inline Max button on the page) get that space back rather than an
  // empty div still taking up its margin. Shared between the desktop card
  // and the mobile sheet — same row, same behavior either way.
  const errorMaxRow = (error || (showMax && balance > 0)) && (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: error ? 'space-between' : 'flex-end', gap: 8, margin: '0 0 10px' }}>
      {error && <p style={{ fontSize: 12, color: 'var(--danger)', margin: 0 }}>{error}</p>}
      {showMax && balance > 0 && (
        <button
          onClick={() => {
            // Raw balances often carry long floating-point tails
            // (e.g. "100.00000000" or "24.9700000001") — dumping
            // that straight into the amount field looked broken.
            // Regular tokens (USDC/EURC) round to at most 4 decimal
            // places and trim trailing zeros. cirBTC is the
            // exception: BTC amounts are commonly tiny fractions
            // like 0.00002365 — rounding those to 4 decimals would
            // collapse them to 0.0000 and lose the actual balance,
            // so it keeps full precision instead, only trimming
            // trailing zeros.
            // BUG FIX: USDC/EURC dust balances (e.g. 0.000004) have the
            // exact same problem at 4 decimals as cirBTC did at 4 — so
            // every token now keeps full 8-decimal precision here too,
            // matching decimalCap above. trimTrailingZeros-style
            // formatting (parseFloat().toString() below) already keeps
            // normal-sized balances looking clean either way.
            const decimals = 8
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
            background: 'color-mix(in srgb, var(--brand) 12%, transparent)', color: 'var(--brand)', fontSize: 12, fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Max
        </button>
      )}
    </div>
  )

  // Done — gated on (balance - feeReserve), the same fee-safe ceiling Max
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
          width: '100%', padding: '15px', borderRadius: 16,
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

  if (isDesktop) {
    // No popup at all — a plain in-flow card, right where the caller
    // places it on the page. Fades/lifts in on mount instead of the
    // mobile slide-up, since there's no "sheet" to slide.
    return (
      <AnimatePresence>
        {open && (
          <motion.div
            key="amount-card"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
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
                  // the typed value got — a long cirBTC amount (up to 10+
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

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Subtle backdrop — just enough separation to feel like a sheet,
              without washing out the amount display above it */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            style={{
              position: 'fixed', top: 0, bottom: 0, left: 0, right: 0,
              maxWidth: 430, margin: '0 auto',
              zIndex: 40,
              background: 'rgba(0,0,0,0.18)',
            }}
          />

          {/* Half sheet */}
          <motion.div
            key="sheet"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 32, stiffness: 300 }}
            style={{
              position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 50,
              maxWidth: 430, margin: '0 auto',
              background: 'var(--surface)',
              borderRadius: '28px 28px 0 0',
              borderTop: '1px solid var(--border)',
              boxShadow: 'var(--shadow-3)',
              padding: '10px 24px 32px',
            }}
          >
            {/* Handle */}
            <div style={{ width: 36, height: 4, borderRadius: 2, background: 'color-mix(in srgb, var(--text-primary) 18%, transparent)', margin: '4px auto 14px' }} />

            {errorMaxRow}

            {/* Keypad — wide rounded-rectangle keys that fill their full grid
                cell (no dead space around a small circle), matching the
                Paytm-style reference. Every key is a real, full-size tap
                target instead of a 60px circle floating inside a wider cell. */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, maxWidth: 320, margin: '0 auto 14px' }}>
              {KEYS.map((key, i) => (
                <button
                  key={i}
                  onClick={() => handleKey(key)}
                  style={{
                    height: 56, borderRadius: 14, width: '100%',
                    background: 'var(--surface)',
                    border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer', fontSize: key === '.' ? 28 : 24, fontWeight: 600, color: key === 'del' ? 'var(--text-secondary)' : 'var(--text-primary)',
                    transition: 'transform 0.1s, background 0.1s',
                  }}
                  onMouseDown={e => { e.currentTarget.style.transform = 'scale(0.95)'; if (key === 'del') startDeleteHold() }}
                  onMouseUp={e => { e.currentTarget.style.transform = 'scale(1)'; if (key === 'del') stopDeleteHold() }}
                  onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; if (key === 'del') stopDeleteHold() }}
                  onTouchStart={e => { e.currentTarget.style.transform = 'scale(0.95)'; if (key === 'del') startDeleteHold() }}
                  onTouchEnd={e => { e.currentTarget.style.transform = 'scale(1)'; if (key === 'del') stopDeleteHold() }}
                  onTouchCancel={e => { e.currentTarget.style.transform = 'scale(1)'; if (key === 'del') stopDeleteHold() }}
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

            {doneButton}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
