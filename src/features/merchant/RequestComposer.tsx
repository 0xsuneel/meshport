// Ask for one amount: the chat's Request sheet and Business → Charge share
// this form, so both look and work the same.
// Layout: header (person / store), amount field with quick amounts, a hint,
// the note, optional extra options (Business: valid for, customer), keypad
// (phone), then the button. Typing in a text box hides the keypad, so the
// amount, the box and the button stay above the phone keyboard.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { AmountField } from '@/components/ui/AmountField'
import { AmountKeypad } from '@/components/ui/AmountKeypad'
import { sheetInputClass, sheetInputStyle } from '@/components/ui/ActionSheet'
import { formatAmount } from '@/lib/utils'

export const MAX_REQUEST = 1_000_000 // the database's limit for one request
const QUICK = ['5', '10', '20', '50']

/** Typed amount → at most `places` decimals (USDC: 6), one dot, no leading zeros. */
export function cleanRequestAmount(raw: string, places = 6): string {
  let v = raw.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1').replace(new RegExp(`^(\\d*\\.\\d{0,${places}}).*$`), '$1')
  if (v.startsWith('.')) v = '0' + v
  v = v.replace(/^0+(?=\d)/, '')
  return v
}

export function RequestAmountForm({ open, isDesktop, header, hint, verb = 'Request', busyText = 'Requesting…', places = 6,
  ariaLabel = 'Amount to request in USDC', options, onCancel, onSubmit }: {
  /** Reset to a blank form whenever this turns true. */
  open: boolean
  isDesktop: boolean
  /** The top of the form; `compact` while the phone keyboard is up. */
  header: (compact: boolean) => ReactNode
  /** Under the amount ("They pay it right here in chat"). */
  hint: string
  /** The button: "Request $12.50" / "Charge $12.50". */
  verb?: string
  busyText?: string
  /** Decimals allowed when typing. */
  places?: number
  ariaLabel?: string
  /** Extra settings behind one row under the note: `summary` on the row,
   *  `panel` in place of the keypad while open. */
  options?: { summary: ReactNode; panel: ReactNode }
  /** A Cancel button beside the main one (left out when the header has ✕). */
  onCancel?: () => void
  /** Creates the request; throws with a message to show. */
  onSubmit: (amount: number, note: string) => Promise<void>
}) {
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [typing, setTyping] = useState(false)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const noteRef = useRef<HTMLInputElement>(null)

  // A fresh form every time it opens.
  useEffect(() => { if (open) { setAmount(''); setNote(''); setError(''); setBusy(false); setTyping(false); setMore(false) } }, [open])

  const n = parseFloat(amount) || 0
  const tooBig = n > MAX_REQUEST
  const valid = n > 0 && !tooBig
  // The button repeats exactly what was typed ("12.50" stays "12.50").
  const amtLabel = amount.replace(/\.$/, '')
  const set = (v: string) => { setAmount(cleanRequestAmount(v, places)); setError('') }

  const submit = async () => {
    if (!valid || busy) return
    setBusy(true); setError('')
    try {
      await onSubmit(n, note.trim())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the request')
    } finally { setBusy(false) }
  }

  const compact = !isDesktop && typing
  // Same amount field as Pay / ChatPay: typed on desktop; on the phone the
  // keypad below is always up, so the field shows as being filled in.
  const amountBox = (
    <div>
      <AmountField
        value={amount}
        onChange={set}
        onTap={isDesktop ? undefined : () => setMore(false)}
        editing={!isDesktop && !typing && !more}
        onEnter={() => void submit()}
        compact={compact}
        invalid={tooBig}
        ariaLabel={ariaLabel}
        token={{ label: 'USDC', logo: '/logos/tokens/usdc.png' }}
        quick={compact ? [] : QUICK.map(v => ({ label: `$${v}`, onClick: () => set(v) }))}
      />
      {!compact && (
        <p className="text-[13px] mt-2" style={{ color: tooBig ? 'var(--danger-text)' : 'var(--text-secondary)', fontWeight: tooBig ? 600 : 500 }}>
          {tooBig ? `Up to $${formatAmount(MAX_REQUEST)} per request` : hint}
        </p>
      )}
    </div>
  )

  return (
    // Top (person / store), the keypad and the button stay put; the amount,
    // note and options scroll between them, so neither the keypad nor the
    // button is pushed below the screen (a store row on top made the form
    // taller than short phones).
    <div className="flex flex-col min-h-0 flex-1"
      // Any text box focused = the phone keyboard is up.
      onFocus={e => { if ((e.target as HTMLElement).tagName === 'INPUT') setTyping(true) }}
      onBlur={e => { if ((e.target as HTMLElement).tagName === 'INPUT') setTyping(false) }}>
      <div className="px-5 flex-shrink-0" style={{ paddingTop: isDesktop ? 20 : 6, paddingBottom: 12 }}>
        {header(compact)}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 flex flex-col gap-3" data-no-drag>
        {amountBox}

        <input ref={noteRef} value={note} maxLength={140} placeholder="What's it for? (optional)" aria-label="Note for the request"
          onChange={e => setNote(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') noteRef.current?.blur() }}
          enterKeyHint="done"
          className={sheetInputClass} style={sheetInputStyle} />

        {options && (!compact || more) && (
          <button type="button" onClick={() => setMore(m => !m)} aria-expanded={more}
            className="w-full flex items-center justify-between gap-2 rounded-[14px] px-3.5 text-[14px] text-text-secondary text-left flex-shrink-0"
            style={{ minHeight: 44, background: 'var(--bg)', border: '1px solid var(--border)', cursor: 'pointer' }}>
            <span className="min-w-0 truncate">{options.summary}</span>
            <ChevronDown className={`size-4 flex-shrink-0 text-text-muted transition-transform ${more ? 'rotate-180' : ''}`} />
          </button>
        )}
        {options && more && <div className="flex flex-col gap-3">{options.panel}</div>}

      </div>

      {/* Keypad and button stay on screen; the amount, note and options above
          scroll if a phone is too short for all of it. */}
      <div className="px-5 flex-shrink-0" style={{ paddingTop: 10, paddingBottom: compact ? 12 : 'calc(env(safe-area-inset-bottom, 0px) + 16px)' }}>
        {!isDesktop && !compact && !more && (
          // The app's amount keypad, right in the form (same decimals cap as
          // typing; keys past the per-request limit are ignored).
          <AmountKeypad variant="inline" open value={amount} onChange={set} decimals={places} maxValue={MAX_REQUEST} showMax={false} />
        )}
        {error && <p role="alert" className="text-sm text-danger text-center mb-2">{error}</p>}
        <div className="flex gap-3">
          {onCancel && !compact && (
            <button type="button" onClick={onCancel}
              className="py-3.5 rounded-2xl text-[15px] font-semibold active:scale-95 transition-transform"
              style={{ flex: 0.8, background: 'color-mix(in srgb, var(--text-primary) 7%, transparent)', border: '1px solid color-mix(in srgb, var(--text-primary) 10%, transparent)', color: 'var(--text-secondary)' }}>
              Cancel
            </button>
          )}
          <button type="button" onClick={submit} disabled={!valid || busy}
            // Keep the keyboard up while tapping the button (the text box blur
            // would otherwise move it before the tap lands).
            onMouseDown={e => e.preventDefault()}
            className="flex-1 py-3.5 rounded-2xl text-[15px] font-bold disabled:opacity-40 active:scale-95 transition-transform"
            style={{ background: 'var(--mustard)', color: 'var(--mustard-ink)' }}>
            {busy ? busyText : valid ? `${verb} $${amtLabel}` : verb}
          </button>
        </div>
      </div>
    </div>
  )
}
