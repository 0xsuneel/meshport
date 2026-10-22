import { useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'

const FULL_FONT = 36
const COMPACT_FONT = 28
const MIN_FONT = 14

export interface QuickAmount { label: string; onClick: () => void; disabled?: boolean }

// The amount box on Pay, Swap, Bulk Pay, Multichain Transfer and Bring, on
// desktop and mobile alike: a soft filled field with the currency sign right
// before the digits, the token (pill or picker) on the right and a brand ring
// while it's being filled in; quick amounts and Max underneath.
//   • Desktop: a real input, typed straight in with the keyboard.
//   • Mobile (`onTap` given): the same field as a display - tapping it opens
//     the page's AmountKeypad sheet, `editing` while that sheet is up.
export function AmountField({
  value, onChange, onMax, ariaLabel, invalid = false, autoFocus = true, readOnly = false, id,
  symbol = '$', token, tokenPicker, quick = [], onTap, editing = false, boxRef, onEnter, compact = false,
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
  /** Fixed token pill on the right (e.g. USDC-only pages). */
  token?: { label: string; logo?: string }
  /** A token picker shown on the right inside the field instead of the pill. */
  tokenPicker?: ReactNode
  /** Quick amounts under the field, e.g. $10 / $50 / $100 or 25% / 50%. */
  quick?: QuickAmount[]
  /** Mobile: tapping the field opens the keypad sheet instead of typing. */
  onTap?: () => void
  /** Mobile: the keypad sheet is open for this field. */
  editing?: boolean
  /** The field itself (the keypad lift keeps it in view). */
  boxRef?: Ref<HTMLDivElement>
  /** Desktop: Enter in the field (e.g. submit the form). */
  onEnter?: () => void
  /** Smaller field, e.g. while the phone keyboard is up for another input. */
  compact?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  const [logoOk, setLogoOk] = useState(true)
  const tapMode = !!onTap
  const ring = invalid ? 'var(--danger)' : 'var(--brand)'
  const active = (tapMode ? editing : focused) || invalid
  // Fit the amount to the room left beside the token: measure it at full
  // size and scale down until it fits (long cirBTC amounts, big numbers).
  const roomRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const BASE_FONT = compact ? COMPACT_FONT : FULL_FONT
  const [fontSize, setFontSize] = useState(BASE_FONT)
  useLayoutEffect(() => {
    const room = roomRef.current, measure = measureRef.current
    if (!room || !measure) return
    const fit = () => {
      const avail = room.clientWidth - 6 // caret
      const full = measure.offsetWidth
      setFontSize(full > avail && full > 0 ? Math.max(MIN_FONT, Math.floor(BASE_FONT * avail / full)) : BASE_FONT)
    }
    fit()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null
    ro?.observe(room)
    return () => ro?.disconnect()
  }, [value, symbol, BASE_FONT])
  const buttons: (QuickAmount & { max?: boolean })[] = [...quick, ...(onMax ? [{ label: 'Max', onClick: onMax, max: true }] : [])]
  const digits = { fontSize, fontWeight: 700, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' as const }

  return (
    <div>
      <div
        ref={boxRef}
        role={tapMode ? 'button' : undefined}
        aria-label={tapMode ? ariaLabel : undefined}
        onClick={tapMode ? (readOnly ? undefined : e => { e.stopPropagation(); onTap() }) : () => inputRef.current?.focus()}
        style={{
          display: 'flex', alignItems: 'center', gap: 12, minHeight: compact ? 56 : 76, padding: compact ? '8px 12px 8px 16px' : '12px 14px 12px 20px', boxSizing: 'border-box',
          borderRadius: 16, cursor: readOnly ? 'default' : tapMode ? 'pointer' : 'text',
          background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)',
          border: `1.5px solid ${active ? ring : 'transparent'}`,
          boxShadow: active ? `0 0 0 4px color-mix(in srgb, ${ring} 18%, transparent)` : 'none',
          transition: 'border-color 0.15s, box-shadow 0.15s',
        }}>
        <div ref={roomRef} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', overflow: 'hidden', position: 'relative' }}>
          {/* Off-screen copy at full size, measured to fit the real one. */}
          <span ref={measureRef} aria-hidden="true" style={{ ...digits, fontSize: BASE_FONT, position: 'absolute', visibility: 'hidden', whiteSpace: 'nowrap', pointerEvents: 'none' }}>
            {symbol}{value || '0.00'}
          </span>
          <span aria-hidden="true" style={{ ...digits, color: 'var(--text-secondary)', flexShrink: 0 }}>{symbol}</span>
          {tapMode ? (
            <span style={{ ...digits, whiteSpace: 'nowrap', color: value ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              {value || '0.00'}
              {editing && <span aria-hidden="true" className="mp-amount-caret" />}
            </span>
          ) : (
            <input
              ref={inputRef}
              id={id}
              type="text"
              inputMode="decimal"
              autoFocus={autoFocus}
              readOnly={readOnly}
              value={value}
              onChange={e => onChange(e.target.value)}
              onKeyDown={onEnter ? e => { if (e.key === 'Enter') onEnter() } : undefined}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="0.00"
              aria-label={ariaLabel}
              aria-invalid={invalid || undefined}
              style={{
                ...digits, flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', padding: 0,
                color: 'var(--text-primary)', caretColor: 'var(--brand-text)',
              }}
            />
          )}
        </div>
        {tokenPicker && (
          // Taps on the picker don't open the keypad / focus the input.
          <div onClick={e => e.stopPropagation()} style={{ flexShrink: 0 }}>{tokenPicker}</div>
        )}
        {token && !tokenPicker && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, padding: token.logo && logoOk ? '5px 12px 5px 5px' : '6px 12px',
            borderRadius: 999, background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
            {token.logo && logoOk && <img decoding="async" src={token.logo} alt="" width={22} height={22} onError={() => setLogoOk(false)} style={{ borderRadius: '50%', display: 'block' }} />}
            {token.label}
          </span>
        )}
      </div>
      {buttons.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          {buttons.map(b => (
            <button key={b.label} type="button" disabled={b.disabled || readOnly}
              onClick={e => { e.stopPropagation(); b.onClick(); if (!tapMode) inputRef.current?.focus() }}
              style={{
                flex: 1, minWidth: 0, height: 34, borderRadius: 10, border: 'none', cursor: b.disabled || readOnly ? 'not-allowed' : 'pointer',
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

/**
 * The small amount box for one row of a list (Pay staff: each person's
 * amount) - the AmountField look at row size: a soft filled box, the "$"
 * before the digits and a brand ring while it's being filled in.
 *   • Desktop: typed straight in.
 *   • Mobile (`onTap` given): tapping opens the page's AmountKeypad sheet,
 *     `editing` while that sheet is up for this row.
 */
export function AmountChip({ value, onChange, ariaLabel, disabled = false, invalid = false, onTap, editing = false, symbol = '$', width = 92 }: {
  value: string
  onChange: (raw: string) => void
  ariaLabel: string
  disabled?: boolean
  invalid?: boolean
  onTap?: () => void
  editing?: boolean
  symbol?: string
  width?: number
}) {
  const [focused, setFocused] = useState(false)
  const ring = invalid ? 'var(--danger)' : 'var(--brand)'
  const active = !disabled && ((onTap ? editing : focused) || invalid)
  const digits = { fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums' as const, lineHeight: 1.2 }
  const box: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2, width, height: 38, padding: '0 10px', boxSizing: 'border-box',
    borderRadius: 12, flexShrink: 0, opacity: disabled ? 0.5 : 1,
    background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)',
    border: `1.5px solid ${active ? ring : 'transparent'}`,
    boxShadow: active ? `0 0 0 3px color-mix(in srgb, ${ring} 18%, transparent)` : 'none',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  }
  const sign = <span aria-hidden="true" style={{ ...digits, color: 'var(--text-secondary)' }}>{symbol}</span>
  if (onTap) {
    return (
      <button type="button" aria-label={ariaLabel} disabled={disabled} onClick={e => { e.stopPropagation(); onTap() }}
        style={{ ...box, cursor: disabled ? 'not-allowed' : 'pointer' }}>
        {sign}
        <span style={{ ...digits, whiteSpace: 'nowrap', overflow: 'hidden', color: value ? 'var(--text-primary)' : 'var(--text-muted)' }}>
          {value || '0'}
          {editing && <span aria-hidden="true" className="mp-amount-caret" />}
        </span>
      </button>
    )
  }
  return (
    <label style={{ ...box, cursor: disabled ? 'not-allowed' : 'text' }}>
      {sign}
      <input type="text" inputMode="decimal" value={value} placeholder="0" disabled={disabled} aria-label={ariaLabel} aria-invalid={invalid || undefined}
        onChange={e => onChange(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={{ ...digits, width: '100%', minWidth: 0, textAlign: 'right', background: 'transparent', border: 'none', outline: 'none', padding: 0,
          color: 'var(--text-primary)', caretColor: 'var(--brand-text)' }} />
    </label>
  )
}
