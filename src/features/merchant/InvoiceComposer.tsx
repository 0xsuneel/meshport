// Merchant chat → Bill. Add products with quantity and price (line totals
// and the bill total update as you type), generate the bill, preview it,
// then send it into the chat. The customer sees a live bill card with
// "Pay invoice". The total is recomputed by the database from the items.
import { useState } from 'react'
import { Plus, Trash2, ArrowLeft, Receipt } from 'lucide-react'
import { formatAmount } from '@/lib/utils'
import { createPaymentRequest, invoiceTotal, type InvoiceItem, type MerchantIntent } from '@/lib/merchantPay'

type Row = { id: number; name: string; qty: string; price: string }

const num = (v: string) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const decimal = (v: string, places: number) =>
  v.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1').replace(new RegExp(`^(\\d*\\.\\d{0,${places}}).*$`), '$1')

const mini: React.CSSProperties = { fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' }
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 12, border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 14, outline: 'none', minWidth: 0,
}

export function InvoiceComposer({ merchantName, customerUsername, onCancel, onSend }: {
  merchantName?: string | null
  customerUsername?: string | null
  onCancel: () => void
  /** Called with the created invoice; the caller posts it into the chat. */
  onSend: (invoice: MerchantIntent) => Promise<void> | void
}) {
  const [rows, setRows] = useState<Row[]>([{ id: 1, name: '', qty: '1', price: '' }])
  const [note, setNote] = useState('')
  const [step, setStep] = useState<'edit' | 'preview'>('edit')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Only complete lines (name, quantity and price) go on the bill.
  const valid: InvoiceItem[] = rows
    .map(r => ({ name: r.name.trim(), qty: num(r.qty), price: num(r.price) }))
    .filter(i => i.name && i.qty > 0 && i.price > 0)
  const total = invoiceTotal(valid)

  const update = (id: number, patch: Partial<Row>) => setRows(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r))
  const addRow = () => setRows(rs => [...rs, { id: (rs[rs.length - 1]?.id ?? 0) + 1, name: '', qty: '1', price: '' }])
  const removeRow = (id: number) => setRows(rs => rs.length > 1 ? rs.filter(r => r.id !== id) : rs)

  const generate = () => {
    setError(null)
    if (valid.length === 0 || !(total > 0)) { setError('Add at least one product with a quantity and price.'); return }
    setStep('preview')
  }

  const send = async () => {
    setBusy(true); setError(null)
    try {
      const inv = await createPaymentRequest({ amount: total, items: valid, note: note || undefined, customer: customerUsername ?? undefined, expiresInMinutes: 7 * 24 * 60 })
      await onSend(inv)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the bill')
    }
    setBusy(false)
  }

  if (step === 'preview') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 20px 20px' }}>
        <button onClick={() => setStep('edit')} style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer', padding: 0 }}>
          <ArrowLeft size={16} /> Edit bill
        </button>
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 18, padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)' }}>{merchantName ?? 'Bill'}</div>
              {customerUsername && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>Bill to {customerUsername.replace(/\.arc$/, '')}.arc</div>}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{new Date().toLocaleDateString()}</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '6px 12px', fontSize: 13, color: 'var(--text-primary)' }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: 11, fontWeight: 700 }}>ITEM</span>
            <span style={{ color: 'var(--text-secondary)', fontSize: 11, fontWeight: 700, textAlign: 'right' }}>QTY × PRICE</span>
            <span style={{ color: 'var(--text-secondary)', fontSize: 11, fontWeight: 700, textAlign: 'right' }}>TOTAL</span>
            {valid.map((i, k) => (
              <Line key={k} item={i} />
            ))}
          </div>
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 10, display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Total</span>
            <span style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)' }}>${formatAmount(total)} USDC</span>
          </div>
          {note && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>{note}</div>}
        </div>
        {error && <div role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div>}
        <button onClick={send} disabled={busy}
          style={{ padding: 14, borderRadius: 14, border: '1px solid color-mix(in srgb, black 12%, transparent)', background: 'var(--brand)', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Sending…' : `Send bill · $${formatAmount(total)}`}
        </button>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 20px 20px' }}>
      {rows.map((r, idx) => {
        const line = Math.round(num(r.qty) * num(r.price) * 1e6) / 1e6
        return (
          <div key={r.id} style={{ background: 'color-mix(in srgb, var(--text-primary) 3%, transparent)', border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)', borderRadius: 16, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input value={r.name} onChange={e => update(r.id, { name: e.target.value })} placeholder={idx === 0 ? 'Item name, e.g. Masala dosa' : `Item ${idx + 1}`} maxLength={80}
                aria-label={`Item ${idx + 1} name`} style={{ ...input, fontWeight: 600 }} />
              {rows.length > 1 && (
                <button onClick={() => removeRow(r.id)} aria-label="Remove item" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 6, flexShrink: 0 }}><Trash2 size={16} /></button>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '72px 16px 1fr auto', gap: 8, alignItems: 'end' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                <span style={mini}>Qty</span>
                <input inputMode="decimal" value={r.qty} onChange={e => update(r.id, { qty: decimal(e.target.value, 3) })} style={{ ...input, textAlign: 'center' }} />
              </label>
              <span style={{ alignSelf: 'center', marginTop: 18, textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>×</span>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                <span style={mini}>Price</span>
                <div style={{ position: 'relative' }}>
                  <span aria-hidden style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 14, fontWeight: 600, color: r.price ? 'var(--text-primary)' : 'var(--text-muted)', pointerEvents: 'none' }}>$</span>
                  <input inputMode="decimal" value={r.price} onChange={e => update(r.id, { price: decimal(e.target.value, 6) })} placeholder="0.00" style={{ ...input, paddingLeft: 24 }} />
                </div>
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end', minWidth: 64 }}>
                <span style={mini}>Amount</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: line > 0 ? 'var(--text-primary)' : 'var(--text-muted)', padding: '10px 0', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>${formatAmount(line)}</span>
              </div>
            </div>
          </div>
        )
      })}
      <button onClick={addRow} disabled={rows.length >= 50}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 11, borderRadius: 14, border: '1px dashed color-mix(in srgb, var(--brand) 45%, var(--border))', background: 'transparent', color: 'var(--brand-text)', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>
        <Plus size={16} /> Add item
      </button>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={mini}>Note (optional)</span>
        <input value={note} onChange={e => setNote(e.target.value)} maxLength={140} placeholder="e.g. Table 4 · Dinner" style={input} />
      </label>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '6px 2px 2px', borderTop: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)', marginTop: 2 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)' }}>Total</span>
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
          <span style={{ fontSize: 24, fontWeight: 800, color: total > 0 ? 'var(--text-primary)' : 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>${formatAmount(total)}</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>USDC</span>
        </span>
      </div>
      {error && <div role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onCancel} style={{ flex: 1, padding: 13, borderRadius: 14, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
        <button onClick={generate}
          style={{ flex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 13, borderRadius: 14, border: '1px solid color-mix(in srgb, black 12%, transparent)', background: 'var(--brand)', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
          <Receipt size={16} /> Generate bill
        </button>
      </div>
    </div>
  )
}

export function Line({ item, muted }: { item: InvoiceItem; muted?: string }) {
  const total = item.total ?? Math.round(item.qty * item.price * 1e6) / 1e6
  return (
    <>
      <span style={{ color: 'inherit', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
      <span style={{ color: muted ?? 'var(--text-secondary)', textAlign: 'right', whiteSpace: 'nowrap' }}>{Number(item.qty)} × ${formatAmount(Number(item.price))}</span>
      <span style={{ textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>${formatAmount(total)}</span>
    </>
  )
}
