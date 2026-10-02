import { amountFontSize } from '@/lib/amountFontSize'

// Desktop amount entry, same look as Swap's "You pay" box: a plain bordered
// box with the digits centred, "$" pinned to the left and a Max pill in the
// top-right corner. Typed straight in with the keyboard — no keypad sheet.
export function DesktopAmountInput({ value, onChange, onMax, ariaLabel, invalid = false, autoFocus = true }: {
  value: string
  /** Raw text as typed; the caller sanitizes it. */
  onChange: (raw: string) => void
  /** Shows the Max pill when given. */
  onMax?: () => void
  ariaLabel: string
  /** Red border (e.g. below the minimum). */
  invalid?: boolean
  autoFocus?: boolean
}) {
  return (
    <div style={{ position: 'relative' }}>
      <div style={{
        position: 'relative',
        background: 'var(--bg)', border: `1px solid ${invalid ? 'var(--danger)' : 'var(--border)'}`, borderRadius: 14,
        padding: '18px 20px', minHeight: 84, display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
      }}>
        <span style={{ position: 'absolute', left: 20, fontSize: 34, fontWeight: 700, color: value ? 'var(--text-primary)' : 'var(--text-muted)', pointerEvents: 'none' }}>$</span>
        <input
          type="text"
          inputMode="decimal"
          autoFocus={autoFocus}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="0.00"
          aria-label={ariaLabel}
          style={{
            width: '100%', background: 'transparent', border: 'none', outline: 'none', padding: 0,
            fontSize: amountFontSize(value, 34), fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums',
            textAlign: 'center',
          }}
        />
      </div>
      {onMax && (
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onMax() }}
          style={{
            position: 'absolute', top: 14, right: 16, padding: '5px 14px', borderRadius: 100,
            border: '1px solid color-mix(in srgb, var(--brand) 40%, transparent)',
            background: 'color-mix(in srgb, var(--brand) 12%, transparent)', color: 'var(--brand)',
            fontSize: 12, fontWeight: 700, cursor: 'pointer',
          }}
        >
          Max
        </button>
      )}
    </div>
  )
}
