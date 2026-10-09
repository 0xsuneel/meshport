import { amountFontSize } from '@/lib/amountFontSize'

/**
 * Big amount entry used on Receive (Request payment, Merchant QR) - the same
 * look as Chat pay's amount: a "$" the same size and weight as the number,
 * faded until something is typed, a monospace number (so its width - and the
 * centring - is exact), and the token name small beside it.
 */
export function AmountHero({ value, onChange, symbol = '$', token = 'USDC', autoFocus, ariaLabel = 'Amount in USDC', maxDecimals = 6, base = 40 }: {
  value: string
  onChange: (v: string) => void
  symbol?: string
  token?: string
  autoFocus?: boolean
  ariaLabel?: string
  maxDecimals?: number
  base?: number
}) {
  const shown = value || '0.00'
  const size = amountFontSize(shown, base)
  const empty = !value
  const faint = 'color-mix(in srgb, var(--text-primary) 22%, transparent)'
  const clean = (raw: string) => raw
    .replace(/[^0-9.]/g, '')
    .replace(/(\..*)\./g, '$1')
    .replace(new RegExp(`^(\\d*\\.\\d{0,${maxDecimals}}).*$`), '$1')
    .replace(/^0+(?=\d)/, '')
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 4, padding: '6px 0 2px' }}>
      <span aria-hidden style={{ fontSize: size, fontWeight: 700, lineHeight: 1, color: empty ? faint : 'var(--text-primary)', transition: 'color .15s' }}>{symbol}</span>
      <input
        className="mp-amount-input"
        inputMode="decimal"
        value={value}
        placeholder="0.00"
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        onChange={e => onChange(clean(e.target.value))}
        style={{
          width: `${shown.length}ch`, minWidth: '1ch', maxWidth: '100%',
          fontSize: size, fontWeight: 700, lineHeight: 1, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          textAlign: 'left', padding: 0, margin: 0, background: 'transparent', border: 'none', outline: 'none',
          color: 'var(--text-primary)', caretColor: 'var(--brand)',
        }}
      />
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginLeft: 4 }}>{token}</span>
    </div>
  )
}
