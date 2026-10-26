// features/p2p/p2pUi.tsx
//
// Pieces shared by the P2P screens (market, order, post ad, my ads):
// payment-method types and their colour tags, the merchant stats line, and
// the sheet that adds or edits a saved payment account (the pay-to details
// a buyer sees on an order - see p2pService's p2p_payment_methods notes).

import { useState, type ReactNode } from 'react'
import { ShieldCheck, X as XIcon } from 'lucide-react'
import { ActionSheet } from '@/components/ui/ActionSheet'
import { savePaymentMethod, paymentMethodSummary, type P2PPaymentMethod, type MerchantStats } from '@/lib/p2pService'

// Each type lists the details a buyer needs to pay it.
export const PAYMENT_METHOD_TYPES: { id: string; color: string; fields: { key: string; label: string; placeholder: string }[] }[] = [
  { id: 'UPI', color: '#F5A524', fields: [{ key: 'upi_id', label: 'UPI ID', placeholder: 'name@okaxis' }] },
  { id: 'IMPS', color: '#3B82F6', fields: [
    { key: 'account', label: 'Account number', placeholder: '000123456789' },
    { key: 'ifsc', label: 'IFSC', placeholder: 'HDFC0001234' },
    { key: 'bank', label: 'Bank', placeholder: 'HDFC Bank' }] },
  { id: 'Bank Transfer', color: '#16A37A', fields: [
    { key: 'account', label: 'Account number', placeholder: '000123456789' },
    { key: 'ifsc', label: 'IFSC / routing / SWIFT', placeholder: 'HDFC0001234' },
    { key: 'bank', label: 'Bank', placeholder: 'Bank name' }] },
  { id: 'SEPA', color: '#2563EB', fields: [{ key: 'iban', label: 'IBAN', placeholder: 'DE89 3704 0044 0532 0130 00' }, { key: 'bank', label: 'Bank', placeholder: 'Bank name' }] },
  { id: 'Wise', color: '#9FE870', fields: [{ key: 'email', label: 'Wise email', placeholder: 'you@example.com' }] },
  { id: 'PayPal', color: '#0070BA', fields: [{ key: 'email', label: 'PayPal email', placeholder: 'you@example.com' }] },
  { id: 'Revolut', color: '#8B5CF6', fields: [{ key: 'phone', label: 'Revolut phone or @tag', placeholder: '@yourtag' }] },
  { id: 'Zelle', color: '#6D1ED4', fields: [{ key: 'email', label: 'Zelle email or phone', placeholder: 'you@example.com' }] },
  { id: 'Cash App', color: '#00D632', fields: [{ key: 'phone', label: '$Cashtag', placeholder: '$yourtag' }] },
  { id: 'Venmo', color: '#3D95CE', fields: [{ key: 'phone', label: 'Venmo @username', placeholder: '@you' }] },
]

export function methodColor(name: string): string {
  const base = name.replace(/\s*\(Demo\)$/, '')
  return PAYMENT_METHOD_TYPES.find(t => t.id === base)?.color ?? '#9CA3AE'
}

/** "UPI" with its colour bar, Binance-style. */
export function MethodTag({ name, size = 11.5 }: { name: string; size?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: size, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
      <i style={{ display: 'inline-block', width: 3, height: size, borderRadius: 2, background: methodColor(name) }} />
      {name.replace(/\s*\(Demo\)$/, '')}
    </span>
  )
}

export function formatRelease(seconds: number | null | undefined): string | null {
  if (seconds == null || !isFinite(seconds)) return null
  if (seconds < 60) return '<1 min'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  return `${Math.round(seconds / 3600)} h`
}

export function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
  return (
    <span style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: `hsl(${hue} 45% 42%)`, color: '#fff', fontSize: size * 0.48, fontWeight: 800 }}>
      {(name || 'U')[0].toUpperCase()}
    </span>
  )
}

/** Name + verified tick, then "1,248 orders · 98.6% · ⏱ 2 min". */
export function MerchantLine({ name, verified, stats, compact }: { name: string; verified?: boolean; stats?: MerchantStats; compact?: boolean }) {
  const release = formatRelease(stats?.avgReleaseSeconds)
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
        <Avatar name={name} size={compact ? 18 : 22} />
        <span style={{ fontSize: compact ? 12.5 : 13.5, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        {verified && <ShieldCheck size={13} color="var(--brand-text)" style={{ flexShrink: 0 }} aria-label="Verified trader" />}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 3, fontSize: 12, color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
        <span>{stats ? `${stats.orders.toLocaleString()} orders` : 'New trader'}{stats?.completionPct != null ? ` · ${stats.completionPct}%` : ''}</span>
        {release && <span>⏱ {release}</span>}
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)', border: '1px solid transparent',
  borderRadius: 12, padding: '12px 14px', fontSize: 'max(var(--fs-field, 0px), 14.5px)', color: 'var(--text-primary)', outline: 'none',
}

/** The P2P sheets' shell: the app's bottom sheet (phone) / centred dialog
 *  (desktop) - ActionSheet - with a title row and a close button. Sits above
 *  P2P's own layers (zIndex 201). Also used by Rewards' claim sheet. */
export function P2PSheet({ open, onClose, title, children, id }: { open: boolean; onClose: () => void; title: string; children: ReactNode; id: string }) {
  return (
    <ActionSheet open={open} onClose={onClose} id={id} fixed zIndex={201}>
      <div style={{ overflowY: 'auto', padding: '6px 20px calc(env(safe-area-inset-bottom, 0px) + 22px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</h2>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex' }}>
            <XIcon size={18} color="var(--text-secondary)" />
          </button>
        </div>
        {children}
      </div>
    </ActionSheet>
  )
}

/** Add or edit a saved payment account. */
export function PaymentMethodSheet({ open, onClose, userId, editing, defaultName, onSaved }: {
  open: boolean; onClose: () => void; userId: string
  editing?: P2PPaymentMethod | null; defaultName?: string
  onSaved: (m: P2PPaymentMethod) => void
}) {
  const [type, setType] = useState(editing?.method ?? 'UPI')
  const [holder, setHolder] = useState(editing?.holderName ?? defaultName ?? '')
  const [details, setDetails] = useState<Record<string, string>>(editing?.details ?? {})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const spec = PAYMENT_METHOD_TYPES.find(t => t.id === type) ?? PAYMENT_METHOD_TYPES[0]

  const save = async () => {
    setSaving(true); setError('')
    const kept = Object.fromEntries(spec.fields.map(f => [f.key, details[f.key] ?? '']))
    const { method, error: err } = await savePaymentMethod(userId, { id: editing?.id, method: type, holderName: holder, details: kept })
    setSaving(false)
    if (!method) { setError(err || 'Could not save'); return }
    onSaved(method); onClose()
  }

  return (
    <P2PSheet open={open} onClose={onClose} title={editing ? 'Edit payment method' : 'Add payment method'} id="p2p-pm">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
        {PAYMENT_METHOD_TYPES.map(t => (
          <button key={t.id} type="button" onClick={() => setType(t.id)} disabled={!!editing && editing.method !== t.id}
            style={{ padding: '6px 11px', borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: 'pointer',
              border: `1.5px solid ${type === t.id ? 'var(--text-primary)' : 'transparent'}`,
              background: type === t.id ? 'var(--surface)' : 'color-mix(in srgb, var(--text-primary) 5%, transparent)',
              color: type === t.id ? 'var(--text-primary)' : 'var(--text-secondary)', opacity: editing && editing.method !== t.id ? 0.4 : 1 }}>
            <MethodTag name={t.id} size={12.5} />
          </button>
        ))}
      </div>
      <label style={{ display: 'block', fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>Account holder name</label>
      <input value={holder} onChange={e => setHolder(e.target.value)} placeholder="Name as on the account" style={{ ...inputStyle, marginBottom: 12 }} />
      {spec.fields.map(f => (
        <div key={f.key} style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>{f.label}</label>
          <input value={details[f.key] ?? ''} onChange={e => setDetails(d => ({ ...d, [f.key]: e.target.value }))} placeholder={f.placeholder} style={inputStyle} />
        </div>
      ))}
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '2px 0 14px', lineHeight: 1.45 }}>
        🔒 Shown only to the buyer of an active order with you - never on your public ad.
      </p>
      {error && <p role="alert" style={{ fontSize: 13, color: 'var(--danger-text)', margin: '0 0 10px' }}>{error}</p>}
      <button onClick={save} disabled={saving}
        style={{ width: '100%', padding: '14px 0', borderRadius: 14, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </P2PSheet>
  )
}

/** Pick which saved accounts to use (ad posting / selling into a buy ad). */
export function PaymentMethodPicker({ methods, selected, onToggle, onAdd, single }: {
  methods: P2PPaymentMethod[]; selected: string[]; onToggle: (id: string) => void; onAdd: () => void; single?: boolean
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {methods.map(m => {
        const on = selected.includes(m.id)
        return (
          <button key={m.id} type="button" onClick={() => onToggle(m.id)}
            style={{ textAlign: 'left', borderRadius: 12, padding: '10px 12px', cursor: 'pointer', background: 'var(--surface)',
              border: `1.5px solid ${on ? 'var(--brand)' : 'var(--border)'}`, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}><MethodTag name={m.method} size={13.5} /></span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{paymentMethodSummary(m)}</span>
            </span>
            <span aria-hidden style={{ width: 20, height: 20, borderRadius: single ? '50%' : 6, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: on ? 'var(--brand)' : 'transparent', border: on ? 'none' : '1.5px solid var(--border)', color: '#fff', fontSize: 12 }}>{on ? '✓' : ''}</span>
          </button>
        )
      })}
      <button type="button" onClick={onAdd}
        style={{ borderRadius: 12, padding: '10px', cursor: 'pointer', background: 'transparent', border: '1.5px dashed var(--border)', color: 'var(--brand-text)', fontWeight: 700, fontSize: 13 }}>
        ＋ Add payment method
      </button>
    </div>
  )
}
