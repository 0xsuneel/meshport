import { useRef, useState } from 'react'
import { amountFontSize } from '@/lib/amountFontSize'

export interface QuickAmount { label: string; onClick: () => void; disabled?: boolean }

// Desktop amount entry (Pay, Swap, Bulk Pay, Multichain Transfer and Bring):
// a soft filled field with the currency sign sitting right before the digits,
// an optional token pill on the right and a brand ring while typing; quick
// amounts and Max underneath. Typed straight in with the keyboard - no keypad
// sheet.
export function DesktopAmountInput({
  value, onChange, onMax, ariaLabel, invalid = false, autoFocus = true, readOnly = false, id,
  symbol = '$', token, quick = [],
}: {
  value: string
  /** Raw text as typed; the caller sanitizes it. */
  onChange: (raw: string) => void
  /** Adds a Max button after the quick amounts. */
  onMax?: () => void
  ariaLabel: string
  /** Red border (e.g. below the minimum). */
  invalid?: boolean
  autoFocus?: boolean
  readOnly?: boolean
  id?: string
  /** Currency sign before the digits ($, €, ₿). */
  symbol?: string
  /** Token pill on the right - left out where the page has its own token picker. */
  token?: { label: string; logo?: string }
  /** Quick amounts under the field, e.g. $10 / $50 / $100 or 25% / 50%. */
  quick?: QuickAmount[]
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  const [logoOk, setLogoOk] = useState(true)
  const ring = invalid ? 'var(--danger)' : 'var(--brand)'
  const active = focused || invalid
  const fontSize = amountFontSize(value, 36)
  const buttons: (QuickAmount & { max?: boolean })[] = [...quick, ...(onMax ? [{ label: 'Max', onClick: onMax, max: true }] : [])]

  return (
    <div>
      <div
        onClick={() => inputRef.current?.focus()}
        style={{
          display: 'flex', alignItems: 'center', gap: 12, minHeight: 76, padding: '12px 14px 12px 20px', boxSizing: 'border-box',
          borderRadius: 16, cursor: 'text',
          background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)',
          border: `1.5px solid ${active ? ring : 'transparent'}`,
          boxShadow: active ? `0 0 0 4px color-mix(in srgb, ${ring} 18%, transparent)` : 'none',
          transition: 'border-color 0.15s, box-shadow 0.15s',
        }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline' }}>
          <span aria-hidden="true" style={{ fontSize, fontWeight: 700, color: 'var(--text-secondary)', flexShrink: 0, lineHeight: 1.2 }}>{symbol}</span>
          <input
            ref={inputRef}
            id={id}
            type="text"
            inputMode="decimal"
            autoFocus={autoFocus}
            readOnly={readOnly}
            value={value}
            onChange={e => onChange(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="0.00"
            aria-label={ariaLabel}
            aria-invalid={invalid || undefined}
            style={{
              flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', padding: 0, lineHeight: 1.2,
              fontSize, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums',
              caretColor: 'var(--brand-text)',
            }}
          />
        </div>
        {token && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, padding: token.logo && logoOk ? '5px 12px 5px 5px' : '6px 12px',
            borderRadius: 999, background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
            {token.logo && logoOk && <img src={token.logo} alt="" width={22} height={22} onError={() => setLogoOk(false)} style={{ borderRadius: '50%', display: 'block' }} />}
            {token.label}
          </span>
        )}
      </div>
      {buttons.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          {buttons.map(b => (
            <button key={b.label} type="button" disabled={b.disabled || readOnly}
              onClick={e => { e.stopPropagation(); b.onClick(); inputRef.current?.focus() }}
              style={{
                flex: 1, height: 34, borderRadius: 10, border: 'none', cursor: b.disabled || readOnly ? 'not-allowed' : 'pointer',
                fontSize: 12.5, fontWeight: b.max ? 700 : 600, opacity: b.disabled || readOnly ? 0.45 : 1,
                color: b.max ? 'var(--brand-text)' : 'var(--text-secondary)',
                background: b.max ? 'color-mix(in srgb, var(--brand) 14%, transparent)' : 'color-mix(in srgb, var(--text-primary) 5%, transparent)',
              }}>
              {b.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** $10 / $50 / $100 style quick amounts that set the field (greyed out above `max`). */
export function quickAmounts(values: number[], symbol: string, set: (v: string) => void, max?: number): QuickAmount[] {
  return values.map(v => ({ label: `${symbol}${v}`, onClick: () => set(String(v)), disabled: max != null && v > max + 1e-9 }))
}
