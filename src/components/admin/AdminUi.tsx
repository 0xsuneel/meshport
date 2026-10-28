// Small pieces every admin console page shares (moved out of
// StuckFundsPage so Transactions, System, Logs and Admins use the same ones).
import { useState, type CSSProperties, type ReactNode } from 'react'
import { Check, Copy, Lock } from 'lucide-react'
import { copyToClipboard } from '@/lib/utils'

export const chainName = (c?: string | null) =>
  !c ? '-' : c === 'Arc_Testnet' ? 'Arc' : c.replace(/_(Sepolia|Testnet|Fuji|Apothem|Amoy_Testnet)$/, '').replace(/_/g, ' ')
export const short = (a?: string | null, n = 6) => (!a ? '-' : a.length > 2 * n + 2 ? `${a.slice(0, n)}…${a.slice(-4)}` : a)
export const usd = (n: number) => `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`
export function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${Math.round(s)}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export function Pill({ children, color }: { children: ReactNode; color: string }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 999, whiteSpace: 'nowrap',
      color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>{children}</span>
  )
}

export function CopyText({ value, mono = true }: { value: string; mono?: boolean }) {
  const [done, setDone] = useState(false)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <span style={{ fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined, wordBreak: 'break-all' }}>{value}</span>
      <button aria-label="Copy" onClick={e => { e.stopPropagation(); copyToClipboard(value).then(ok => { if (ok) { setDone(true); setTimeout(() => setDone(false), 1200) } }) }}
        style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex', flexShrink: 0 }}>
        {done ? <Check data-tick size={13} color="var(--success)" /> : <Copy size={13} />}
      </button>
    </span>
  )
}

export function Field({ label, children, locked }: { label: string; children: ReactNode; locked?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, padding: '10px 0', borderTop: '1px solid var(--border)', fontSize: 13 }}>
      <span style={{ color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
        {locked && <Lock size={12} aria-label="Locked" />}{label}
      </span>
      <span style={{ color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right', minWidth: 0 }}>{children}</span>
    </div>
  )
}

export function ActionButton({ children, onClick, disabled, primary, icon }: {
  children: ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean; icon?: ReactNode
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 42, padding: '0 14px',
        borderRadius: 12, fontSize: 13, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
        background: primary ? 'var(--brand)' : 'transparent', color: primary ? '#fff' : 'var(--text-primary)',
        border: primary ? 'none' : '1px solid var(--border)', flex: '1 1 auto',
      }}>
      {icon}{children}
    </button>
  )
}

export const chip = (active: boolean): CSSProperties => ({
  padding: '7px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
  background: active ? 'var(--brand)' : 'var(--surface)', color: active ? '#fff' : 'var(--text-secondary)', border: '1px solid var(--border)',
})

/** One row of filter chips. */
export function Chips<K extends string>({ items, value, onChange }: { items: readonly { key: NoInfer<K>; label: string }[]; value: K; onChange: (k: NoInfer<K>) => void }) {
  return (
    <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
      {items.map(i => <button key={i.key} onClick={() => onChange(i.key)} style={chip(value === i.key)}>{i.label}</button>)}
    </div>
  )
}

/** Red box for a failed request, grey for an empty result. */
export function Notice({ tone = 'muted', children }: { tone?: 'error' | 'muted'; children: ReactNode }) {
  const error = tone === 'error'
  return (
    <div style={{ padding: '12px 14px', borderRadius: 12, fontSize: 13, lineHeight: 1.45,
      color: error ? 'var(--danger-text)' : 'var(--text-secondary)',
      background: error ? 'color-mix(in srgb, var(--danger) 10%, transparent)' : 'color-mix(in srgb, var(--text-primary) 4%, transparent)' }}>
      {children}
    </div>
  )
}

export const mono: CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
