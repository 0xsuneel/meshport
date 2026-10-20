// Bill composer: merchant chat → Bill and Business → Collect payment → Bill
// share it (BillComposer), so both look and work the same. Items with
// quantity and price (line totals and the bill total update as you type), an
// optional note and a due date, then Send / Create bill. The database
// recomputes the total from the items.
//
// Built for long bills: finished items collapse to one line ("Masala dosa ·
// 2 × $3.50 · $7.00"), only the item being edited opens up, and only the
// list scrolls - the person at the top and the total + Send at the bottom
// stay put. With the phone keyboard up, the header and footer shrink to one
// line each and Next walks name → price → next item.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Plus, Receipt, X } from 'lucide-react'
import { formatAmount } from '@/lib/utils'
import { createPaymentRequest, invoiceTotal, invoiceBreakdown, type InvoiceItem, type MerchantIntent } from '@/lib/merchantPay'
import { ActionSheet, SheetPerson, SheetLabel, SheetChips, sheetInputClass, sheetInputStyle } from '@/components/ui/ActionSheet'
import { DUE_PRESETS, duePresetDate, dueText, isoDay, type DuePresetId } from '@/lib/businessBills'
import type { SavedItem } from '@/lib/businessItems'
import { StorePicker, type PickerStore } from './StorePicker'

export const MAX_BILL_ITEMS = 50 // the database's limit
type Row = { id: number; name: string; qty: string; price: string }

const num = (v: string) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const decimal = (v: string, places: number) =>
  v.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1').replace(new RegExp(`^(\\d*\\.\\d{0,${places}}).*$`), '$1')
const lineTotal = (r: Row) => Math.round(num(r.qty) * num(r.price) * 1e6) / 1e6
/** Bill money always shows cents: $9.40, not $9.4 (more decimals only when typed). */
export const billMoney = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
const isBlank = (r: Row) => !r.name.trim() && !num(r.price)
const isComplete = (r: Row) => !!r.name.trim() && num(r.qty) > 0 && num(r.price) > 0
/** What a started-but-unfinished item still needs (null when it's fine or blank). */
export function rowProblem(r: Row): string | null {
  if (isBlank(r) || isComplete(r)) return null
  if (!r.name.trim()) return 'Add a name'
  if (!(num(r.qty) > 0)) return 'Add a quantity'
  return 'Add a price'
}

const field: React.CSSProperties = {
  boxSizing: 'border-box', height: 36, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)',
  color: 'var(--text-primary)', fontSize: 15, outline: 'none', minWidth: 0,
}

/** What BillComposer hands back on Send / Create. */
export type BillDraft = { items: InvoiceItem[]; total: number; taxPercent?: number; note?: string; dueDate: string | null }

export function BillComposer({ open, isDesktop, header, footerNote, submitLabel = 'Send bill', busyLabel = 'Sending…', saved, extra, onCreate }: {
  /** Reset to a blank bill whenever this turns true. */
  open: boolean
  isDesktop: boolean
  /** The top of the sheet (who it's for); `compact` while the keyboard is up. */
  header: (compact: boolean) => ReactNode
  /** Under the button; `due` is e.g. "Due 25 Oct" when a due date is picked. */
  footerNote: (due: string | null) => string
  submitLabel?: string
  busyLabel?: string
  /** Saved products (Business): tap to add, Edit to remove. */
  saved?: { items: SavedItem[]; onRemove: (it: SavedItem) => void; hint?: string }
  /** More fields after the note (Business: Bill to), kept while typing. */
  extra?: ReactNode
  /** Creates the bill; throws with a message to show. */
  onCreate: (bill: BillDraft) => Promise<void>
}) {
  const [rows, setRows] = useState<Row[]>([{ id: 1, name: '', qty: '1', price: '' }])
  const [editing, setEditing] = useState<number | null>(1)
  const [note, setNote] = useState('')
  const [tax, setTax] = useState('')
  const [dueId, setDueId] = useState<DuePresetId>('none')
  const [customDue, setCustomDue] = useState('')
  const [typing, setTyping] = useState(false)
  const [editSaved, setEditSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRefs = useRef(new Map<number, HTMLInputElement>())
  const priceRefs = useRef(new Map<number, HTMLInputElement>())
  const rowRefs = useRef(new Map<number, HTMLDivElement>())
  const focusSoon = (el: () => HTMLElement | undefined) => requestAnimationFrame(() => el()?.focus())

  // A fresh bill every time the sheet opens.
  useEffect(() => {
    if (!open) return
    setRows([{ id: 1, name: '', qty: '1', price: '' }]); setEditing(1); setNote(''); setTax(''); setDueId('none'); setCustomDue(''); setError(null); setBusy(false); setTyping(false); setEditSaved(false)
  }, [open])
  // The item being edited stays in view (keyboard opening, Next, Add item).
  useEffect(() => {
    if (editing == null) return
    const el = rowRefs.current.get(editing)
    requestAnimationFrame(() => el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  }, [editing, typing])

  const valid: InvoiceItem[] = rows.filter(isComplete).map(r => ({ name: r.name.trim(), qty: num(r.qty), price: num(r.price) }))
  const taxPct = Math.min(100, Math.max(0, num(tax)))
  const bill = invoiceBreakdown(valid, taxPct)
  const total = bill.total
  // A bill with a due date stays open until it's paid; without one it's
  // valid for 7 days.
  const dueDate = dueId === 'custom' ? (customDue || null) : duePresetDate(dueId)
  const due = dueText(dueDate, true)
  const pickDue = (id: DuePresetId) => { setDueId(id); setError(null); if (id === 'custom' && !customDue) setCustomDue(duePresetDate('7') ?? '') }
  const atLimit = rows.length >= MAX_BILL_ITEMS

  const update = (id: number, patch: Partial<Row>) => { setRows(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r)); setError(null) }
  const addRow = () => {
    if (atLimit) return
    const id = (rows[rows.length - 1]?.id ?? 0) + 1
    setRows(rs => [...rs, { id, name: '', qty: '1', price: '' }])
    setEditing(id)
    focusSoon(() => nameRefs.current.get(id))
  }
  const removeRow = (id: number) => {
    setError(null)
    if (rows.length === 1) { setRows([{ id, name: '', qty: '1', price: '' }]); return }
    const at = rows.findIndex(r => r.id === id)
    setRows(rs => rs.filter(r => r.id !== id))
    if (editing === id) setEditing(rows[at + 1]?.id ?? rows[at - 1]?.id ?? null)
  }
  // A saved product: one more of it, or a new finished line (in place of a
  // still-blank one).
  const addSaved = (it: SavedItem) => {
    setError(null)
    const at = rows.findIndex(r => r.name.trim().toLowerCase() === it.name.toLowerCase())
    if (at >= 0) { setRows(rs => rs.map((r, i) => i === at ? { ...r, qty: String(Math.round((num(r.qty) + 1) * 1000) / 1000) } : r)); return }
    const base = rows.filter(r => !isBlank(r))
    if (base.length >= MAX_BILL_ITEMS) return
    const id = (rows[rows.length - 1]?.id ?? 0) + 1
    setRows([...base, { id, name: it.name, qty: '1', price: String(it.price) }])
    setEditing(null)
  }
  const step = (r: Row, d: number) => {
    const q = Math.round((num(r.qty) + d) * 1000) / 1000
    if (q >= 1) update(r.id, { qty: String(q) })
  }
  // Next on a price: the next item, or a new one once this one is complete.
  const nextFromPrice = (r: Row) => {
    const at = rows.findIndex(x => x.id === r.id)
    const next = rows[at + 1]
    if (next) { setEditing(next.id); focusSoon(() => nameRefs.current.get(next.id)); return }
    if (isComplete(r) && !atLimit) { addRow(); return }
    priceRefs.current.get(r.id)?.blur()
  }

  const send = async () => {
    if (busy) return
    const bad = rows.find(r => rowProblem(r))
    if (bad) {
      setEditing(bad.id)
      setError(`${bad.name.trim() ? `“${bad.name.trim()}”` : 'An item'}: ${rowProblem(bad)!.toLowerCase()}`)
      return
    }
    if (valid.length === 0 || !(total > 0)) { setError('Add at least one item with a price.'); return }
    if (dueId === 'custom' && !customDue) { setError('Pick a due date.'); return }
    setBusy(true); setError(null)
    try {
      await onCreate({ items: valid, total, taxPercent: taxPct || undefined, note: note.trim() || undefined, dueDate })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the bill')
    } finally { setBusy(false) }
  }

  const compact = !isDesktop && typing
  const sendDisabled = busy || valid.length === 0

  return (
    <div className="flex flex-col min-h-0 flex-1"
      // Any field in the sheet focused = the phone keyboard is up.
      onFocus={e => { const t = e.target as HTMLInputElement; if (t.tagName === 'INPUT' && t.type !== 'date') setTyping(true) }}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setTyping(false) }}>
      <div className="px-5 flex-shrink-0" style={{ paddingTop: isDesktop ? 20 : 4, paddingBottom: compact ? 8 : 12 }}>
        {header(compact)}
        {!compact && (
          <div className="flex items-center justify-between mt-3 px-0.5">
            <span className="text-[12px] font-bold uppercase tracking-[0.06em] text-text-secondary">Items{valid.length ? ` · ${valid.length}` : ''}</span>
            {rows.length > 1 && <span className="text-[11.5px] font-semibold text-text-muted">{rows.length} of {MAX_BILL_ITEMS}</span>}
          </div>
        )}
      </div>

      {/* Only this scrolls. */}
      <div className="flex-1 min-h-0 overflow-y-auto px-5" data-no-drag>
        {saved && saved.items.length > 0 && !compact && (
          <div className="mb-3">
            <div className="flex items-center justify-between px-0.5 mb-1.5">
              <span className="text-[12px] font-semibold text-text-muted">{editSaved ? 'Tap to remove' : 'Saved items · tap to add'}</span>
              <button type="button" onClick={() => setEditSaved(e => !e)} className="text-[12.5px] font-bold" style={{ color: 'var(--brand-text)', background: 'none', border: 'none', cursor: 'pointer' }}>{editSaved ? 'Done' : 'Edit'}</button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {saved.items.map(it => (
                <button key={it.id} type="button" onClick={() => (editSaved ? saved.onRemove(it) : addSaved(it))}
                  aria-label={editSaved ? `Remove ${it.name}` : `Add ${it.name}`}
                  className="inline-flex items-center gap-1.5 px-3 rounded-full text-[13px] font-semibold"
                  style={{ height: 32, cursor: 'pointer', border: `1px solid ${editSaved ? 'color-mix(in srgb, var(--danger) 45%, transparent)' : 'var(--border)'}`,
                    background: 'var(--bg)', color: editSaved ? 'var(--danger)' : 'var(--text-primary)' }}>
                  {it.name} <span style={{ color: editSaved ? 'inherit' : 'var(--text-muted)', fontWeight: 500 }}>{editSaved ? <X size={13} /> : `$${billMoney(it.price)}`}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)', background: 'var(--bg)' }}>
          {rows.map((r, idx) => {
            const open = editing === r.id
            const problem = rowProblem(r)
            const line = lineTotal(r)
            const top = idx ? '1px solid var(--border)' : 'none'
            if (!open) {
              return (
                <button key={r.id} type="button" ref={el => { if (el) rowRefs.current.set(r.id, el as unknown as HTMLDivElement); else rowRefs.current.delete(r.id) }}
                  onClick={() => { setEditing(r.id); focusSoon(() => (r.name ? priceRefs : nameRefs).current.get(r.id)) }}
                  className="w-full flex items-center gap-2 text-left px-3.5"
                  style={{ minHeight: 46, borderTop: top, background: 'transparent', cursor: 'pointer' }}>
                  <span className="flex-1 min-w-0 truncate text-[14.5px] font-semibold" style={{ color: r.name.trim() ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                    {r.name.trim() || 'Item name'}
                  </span>
                  {problem
                    ? <span className="text-[12.5px] font-semibold flex-shrink-0" style={{ color: 'var(--warning)' }}>{problem}</span>
                    : <span className="text-[13px] text-text-secondary flex-shrink-0 tabular-nums">{Number(num(r.qty))} × ${billMoney(num(r.price))}</span>}
                  <span className="text-[14.5px] font-bold flex-shrink-0 text-right tabular-nums" style={{ minWidth: 56, color: line > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>${billMoney(line)}</span>
                </button>
              )
            }
            return (
              <div key={r.id} ref={el => { if (el) rowRefs.current.set(r.id, el); else rowRefs.current.delete(r.id) }}
                className="px-3.5 py-3" style={{ borderTop: top, background: 'color-mix(in srgb, var(--brand) 9%, transparent)' }}>
                <div className="flex items-center gap-2">
                  <input ref={el => { if (el) nameRefs.current.set(r.id, el); else nameRefs.current.delete(r.id) }}
                    value={r.name} maxLength={80} placeholder={idx === 0 ? 'Item name, e.g. Masala dosa' : 'Item name'} aria-label={`Item ${idx + 1} name`}
                    enterKeyHint="next" autoComplete="off"
                    onChange={e => update(r.id, { name: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); priceRefs.current.get(r.id)?.focus() } }}
                    className="flex-1 px-2.5 font-semibold placeholder:text-text-muted placeholder:font-medium focus:border-[var(--brand-text)]"
                    style={field} />
                  <button type="button" onClick={() => removeRow(r.id)} aria-label={rows.length > 1 ? 'Remove item' : 'Clear item'}
                    className="flex-shrink-0 flex items-center justify-center" style={{ width: 30, height: 30, borderRadius: 15, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
                    <X size={17} />
                  </button>
                </div>
                <div className="flex items-center gap-2 mt-2.5">
                  <div className="flex items-center flex-shrink-0" style={{ height: 34, borderRadius: 999, border: '1px solid var(--border)', background: 'var(--surface)' }}>
                    <button type="button" onClick={() => step(r, -1)} aria-label="One less" disabled={num(r.qty) <= 1}
                      className="disabled:opacity-35" style={{ width: 32, height: 32, border: 'none', background: 'none', color: 'var(--brand-text)', fontSize: 19, fontWeight: 700, cursor: 'pointer' }}>−</button>
                    <input value={r.qty} inputMode="decimal" aria-label={`Item ${idx + 1} quantity`} enterKeyHint="next"
                      onChange={e => update(r.id, { qty: decimal(e.target.value, 3) })}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); priceRefs.current.get(r.id)?.focus() } }}
                      className="text-center font-bold bg-transparent outline-none" style={{ width: Math.max(24, r.qty.length * 10 + 8), border: 'none', fontSize: 14.5, color: 'var(--text-primary)' }} />
                    <button type="button" onClick={() => step(r, 1)} aria-label="One more"
                      style={{ width: 32, height: 32, border: 'none', background: 'none', color: 'var(--brand-text)', fontSize: 19, fontWeight: 700, cursor: 'pointer' }}>+</button>
                  </div>
                  <span className="text-text-muted text-[14px]">×</span>
                  <div className="relative" style={{ width: 104 }}>
                    <span aria-hidden className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[15px] font-semibold pointer-events-none" style={{ color: r.price ? 'var(--text-primary)' : 'var(--text-muted)' }}>$</span>
                    <input ref={el => { if (el) priceRefs.current.set(r.id, el); else priceRefs.current.delete(r.id) }}
                      value={r.price} inputMode="decimal" placeholder="0.00" aria-label={`Item ${idx + 1} price`} enterKeyHint="next"
                      onChange={e => update(r.id, { price: decimal(e.target.value, 6) })}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); nextFromPrice(r) } }}
                      className="w-full font-semibold placeholder:text-text-muted placeholder:font-medium focus:border-[var(--brand-text)]"
                      style={{ ...field, paddingLeft: 22, paddingRight: 8 }} />
                  </div>
                  <span className="ml-auto text-[15px] font-bold tabular-nums whitespace-nowrap" style={{ color: line > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>${billMoney(line)}</span>
                </div>
              </div>
            )
          })}
          <button type="button" onClick={addRow} disabled={atLimit}
            className="w-full flex items-center justify-center gap-1.5 text-[14px] font-bold disabled:opacity-40"
            style={{ height: 44, borderTop: '1px dashed var(--border)', background: 'transparent', color: 'var(--brand-text)', cursor: atLimit ? 'default' : 'pointer' }}>
            <Plus size={16} /> {atLimit ? `${MAX_BILL_ITEMS} items is the most for one bill` : 'Add item'}
          </button>
        </div>
        {saved?.hint && saved.items.length === 0 && !compact && <p className="text-[12px] text-text-muted mt-1.5 px-0.5">{saved.hint}</p>}
        <input value={note} onChange={e => setNote(e.target.value)} maxLength={140} placeholder="What's it for? (optional)" aria-label="Note"
          enterKeyHint="done" onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          className={`${sheetInputClass} mt-3 mb-1`} style={sheetInputStyle} />
        {extra}
        {!compact && (
          <div className="flex items-center justify-between mt-3 px-0.5">
            <SheetLabel>Tax %</SheetLabel>
            <input value={tax} onChange={e => { setTax(e.target.value.replace(/[^0-9.]/g, '').slice(0, 5)); setError(null) }}
              inputMode="decimal" placeholder="0" aria-label="Tax percent"
              className="w-20 h-9 px-3 rounded-xl bg-surface border border-border text-right text-[14px] tabular-nums text-text-primary focus:outline-none focus:ring-2 focus:ring-brand/40" />
          </div>
        )}
        {!compact && (
          <div className="mt-3 mb-1">
            <SheetLabel>Due date</SheetLabel>
            <SheetChips label="Due date" options={DUE_PRESETS} value={dueId} onChange={pickDue} />
            {dueId === 'custom' && (
              <input type="date" value={customDue} min={isoDay(new Date())} max={isoDay(new Date(Date.now() + 365 * 86_400_000))}
                onChange={e => { setCustomDue(e.target.value); setError(null) }} aria-label="Custom due date"
                className="w-full mt-2 px-3 focus:border-[var(--brand-text)]" style={{ ...field, height: 40 }} />
            )}
            {dueDate && <p className="text-[12px] text-text-muted mt-1.5 px-0.5">The bill stays open until it's paid.</p>}
          </div>
        )}
        {!compact && <p className="text-[12px] text-text-muted mt-3 mb-2 px-0.5">{footerNote(due?.text ?? null)}</p>}
      </div>

      {/* Total + Send - always on screen. */}
      <div className="px-5 flex-shrink-0" style={{ borderTop: '1px solid var(--border)', paddingTop: compact ? 8 : 10, paddingBottom: compact ? 10 : 'calc(env(safe-area-inset-bottom, 0px) + 18px)' }}>
        {error && <p role="alert" className="text-[13px] text-danger mb-2">{error}</p>}
        {/* One row - the total and the button - so the items get the screen. */}
        {!compact && taxPct > 0 && valid.length > 0 && (
          <p className="text-[12px] text-text-muted tabular-nums mb-1.5 px-0.5">Subtotal ${billMoney(bill.subtotal)} · Tax ({taxPct}%) + ${billMoney(bill.tax)}</p>
        )}
        <div className="flex items-center gap-3">
          <div className="min-w-0">
            <p className="text-[12px] font-semibold text-text-secondary">Total{valid.length ? ` · ${valid.length} item${valid.length === 1 ? '' : 's'}` : ''}</p>
            <p className="text-[22px] font-extrabold tabular-nums leading-tight" style={{ color: total > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>${billMoney(total)} <span className="text-[12px] font-bold text-text-secondary">USDC</span></p>
          </div>
          <button type="button" onClick={send} disabled={sendDisabled} onMouseDown={e => { if (compact) e.preventDefault() }}
            className="ml-auto flex items-center gap-1.5 px-5 rounded-2xl text-[15px] font-bold text-white disabled:opacity-40 active:scale-[0.98] transition-transform"
            style={{ height: compact ? 46 : 50, background: 'var(--brand)' }}>
            <Receipt size={16} /> {busy ? busyLabel : submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Merchant chat → Bill: the bill goes to this chat's person as a bill card. */
export function ChatBillSheet({ open, onClose, isDesktop, merchantName, customer, store, onSend }: {
  open: boolean
  onClose: () => void
  isDesktop: boolean
  merchantName?: string | null
  customer: { name: string; username: string; avatar?: string | null }
  /** Several stores: which one the bill is from. */
  store?: { list: PickerStore[]; value: string; onChange: (id: string) => void }
  /** Called with the created bill; the caller posts it into the chat. */
  onSend: (invoice: MerchantIntent) => Promise<void> | void
}) {
  const firstName = customer.name || customer.username.replace(/\.arc$/i, '')
  return (
    <ActionSheet open={open} onClose={onClose} isDesktop={isDesktop} id="chat-bill">
      <BillComposer open={open} isDesktop={isDesktop}
        header={compact => <div className="flex flex-col gap-3">
          <SheetPerson label="Bill to" name={customer.name} username={customer.username} avatar={customer.avatar}
            compact={compact} onClose={onClose} sub={merchantName && !(store && store.list.length > 1) ? `From ${merchantName}` : null} />
          {!compact && store && store.list.length > 1 && <StorePicker stores={store.list} value={store.value} onChange={store.onChange} label="Bill from store" />}
        </div>}
        footerNote={due => `${firstName} gets a bill card with a Pay button${due ? ` · ${due}` : ''}`}
        onCreate={async ({ items, total, taxPercent, note, dueDate }) => {
          const inv = await createPaymentRequest({ amount: total, items, taxPercent, note, customer: customer.username,
            storeId: store?.value ?? null, expiresInMinutes: dueDate ? null : 7 * 24 * 60, dueDate })
          await onSend(inv)
          onClose()
        }} />
    </ActionSheet>
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
