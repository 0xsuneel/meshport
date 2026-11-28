/**
 * BizPaymentsView - a business account's Payments tab (27 Nov): every
 * payment, named by who paid and how it was collected - never by an order
 * number. Tabs by how it came in (All · Shop QR · Charges · Bills), filters
 * (date, counter/store, staff, paid via), search, and the totals for what's
 * shown. Bills keep their number: a bill is a document.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Search, X, ChevronDown, Download, CreditCard, ClipboardList } from 'lucide-react'
import type { Payment, PaymentViaKind } from './types'
import { PaymentRow } from './OverviewView'
import { Skeleton } from './primitives'

type Tab = 'all' | 'shop' | 'charge' | 'bill'
const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'shop', label: 'Shop QR' }, { id: 'charge', label: 'Charges' }, { id: 'bill', label: 'Bills' },
]
const tabOf = (k: PaymentViaKind | undefined): Tab | null => k === 'shop' ? 'shop' : k === 'charge' ? 'charge' : k === 'bill' ? 'bill' : null

type DateRange = 'today' | 'yesterday' | 'week' | 'month' | 'all'
const DATES: { id: DateRange; label: string }[] = [
  { id: 'today', label: 'Today' }, { id: 'yesterday', label: 'Yesterday' }, { id: 'week', label: 'Last 7 days' },
  { id: 'month', label: 'Last 30 days' }, { id: 'all', label: 'All time' },
]
const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime() }
function inRange(iso: string, r: DateRange): boolean {
  if (r === 'all') return true
  const t = Date.parse(iso), today = startOfDay(new Date()), day = 86_400_000
  if (r === 'today') return t >= today
  if (r === 'yesterday') return t >= today - day && t < today
  return t >= today - (r === 'week' ? 6 : 29) * day
}
const dayLabel = (iso: string) => {
  const t = startOfDay(new Date(iso)), today = startOfDay(new Date())
  if (t === today) return 'Today'
  if (t === today - 86_400_000) return 'Yesterday'
  return new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
}
const num = (s: string) => Number(s.replace(/[^0-9.-]/g, '')) || 0
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** A filter chip with a native picker over it (the phone's own list). */
function PickChip({ label, value, options, onChange }: { label: string; value: string; options: { id: string; label: string }[]; onChange: (v: string) => void }) {
  const on = value !== ''
  const shown = options.find(o => o.id === value)?.label
  return (
    <label className="relative shrink-0 inline-flex items-center gap-1 h-8 px-3 rounded-full border text-[12.5px] font-semibold whitespace-nowrap"
      style={on ? { borderColor: 'var(--brand-text)', color: 'var(--brand-text)', background: 'color-mix(in srgb, var(--brand) 10%, transparent)' } : { borderColor: 'var(--border)', background: 'var(--card)', color: 'var(--text-primary)' }}>
      {shown ?? label} <ChevronDown className="size-3.5" />
      <select aria-label={label} value={value} onChange={e => onChange(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer">
        {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </label>
  )
}

export interface BizPaymentsViewProps {
  loading: boolean
  payments: Payment[]
  onPayment: (p: Payment) => void
  /** Refunded so far per payment id (pre-formatted is on the row; this is the number). */
  refundedOf: (id: string) => number
  /** Open charges and bills waiting to be paid (opens that list). */
  openOrders?: { count: number; onOpen: () => void }
  onDownload?: () => void
  /** Shown as the date chip's first pick. */
  initialDate?: DateRange
  header?: ReactNode
}

export function BizPaymentsView({ loading, payments, onPayment, refundedOf, openOrders, onDownload, initialDate = 'today', header }: BizPaymentsViewProps) {
  const [tab, setTab] = useState<Tab>('all')
  const [date, setDate] = useState<DateRange>(initialDate)
  const [store, setStore] = useState('')
  const [staff, setStaff] = useState('')
  const [via, setVia] = useState('')
  const [q, setQ] = useState('')
  const [searching, setSearching] = useState(false)

  const stores = useMemo(() => [...new Set(payments.map(p => p.store).filter(Boolean) as string[])], [payments])
  const staffList = useMemo(() => [...new Set(payments.map(p => p.staff).filter(Boolean) as string[])], [payments])
  const chains = useMemo(() => [...new Set(payments.map(p => p.chainLabel))], [payments])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return payments.filter(p => (tab === 'all' || tabOf(p.via?.kind) === tab)
      && inRange(p.time, date)
      && (!store || p.store === store)
      && (!staff || (staff === '_owner' ? !p.staff : p.staff === staff))
      && (!via || p.chainLabel === via)
      && (!needle || [p.from, p.wallet, p.via?.tag, p.via?.detail, p.reference, p.amount].some(x => x && String(x).toLowerCase().includes(needle))))
  }, [payments, tab, date, store, staff, via, q])

  const total = shown.filter(p => p.status !== 'refunded').reduce((t, p) => t + num(p.amount), 0)
  const refunded = shown.reduce((t, p) => t + refundedOf(p.id), 0)
  const groups = useMemo(() => {
    const m = new Map<string, Payment[]>()
    for (const p of shown) { const k = dayLabel(p.time); m.set(k, [...(m.get(k) ?? []), p]) }
    return [...m.entries()]
  }, [shown])

  return (
    <div className="flex flex-col pb-6">
      {header}
      {/* How it came in */}
      <div className="flex gap-5 px-5 border-b border-border overflow-x-auto no-scrollbar" role="tablist" aria-label="How it was collected">
        {TABS.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className="shrink-0 py-2.5 text-[14px] font-bold"
            style={{ color: tab === t.id ? 'var(--text-primary)' : 'var(--text-muted)', borderBottom: `2.5px solid ${tab === t.id ? 'var(--brand)' : 'transparent'}` }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 px-4 pt-3 overflow-x-auto no-scrollbar">
        <PickChip label="Date" value={date} options={DATES} onChange={v => setDate(v as DateRange)} />
        {stores.length > 1 && <PickChip label="Counter" value={store} options={[{ id: '', label: 'All counters' }, ...stores.map(s => ({ id: s, label: s }))]} onChange={setStore} />}
        {staffList.length > 0 && <PickChip label="Staff" value={staff} options={[{ id: '', label: 'Everyone' }, { id: '_owner', label: 'You' }, ...staffList.map(s => ({ id: s, label: s }))]} onChange={setStaff} />}
        {chains.length > 1 && <PickChip label="Paid via" value={via} options={[{ id: '', label: 'Any network' }, ...chains.map(c => ({ id: c, label: c }))]} onChange={setVia} />}
        <button type="button" aria-label="Search payments" onClick={() => setSearching(s => !s)}
          className="shrink-0 size-8 inline-flex items-center justify-center rounded-full border border-border bg-card text-text-secondary">
          {searching ? <X className="size-4" /> : <Search className="size-4" />}
        </button>
      </div>
      {searching && (
        <div className="px-4 pt-2">
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, wallet, what it was for, reference"
            aria-label="Search payments" className="w-full h-11 px-4 rounded-2xl bg-card border border-border text-[14px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand/40" />
        </div>
      )}

      {/* Totals for what's shown */}
      <div className="mx-4 mt-3 rounded-[20px] bg-card border border-border px-4 py-3 grid grid-cols-3 gap-2">
        <div><p className="text-[17px] font-bold tabular-nums text-text-primary">{loading ? '–' : shown.length}</p><p className="text-[11.5px] text-text-muted">Payments</p></div>
        <div className="text-center"><p className="text-[17px] font-bold tabular-nums text-text-primary">{loading ? '–' : usd(total)}</p><p className="text-[11.5px] text-text-muted">Total</p></div>
        <div className="text-right"><p className="text-[17px] font-bold tabular-nums text-text-primary">{loading ? '–' : usd(refunded)}</p><p className="text-[11.5px] text-text-muted">Refunded</p></div>
      </div>

      {(openOrders && openOrders.count > 0) || onDownload ? (
        <div className="flex items-center justify-between px-5 pt-2.5">
          {openOrders && openOrders.count > 0
            ? <button type="button" onClick={openOrders.onOpen} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-brand-text"><ClipboardList className="size-4" /> {openOrders.count} waiting to be paid ›</button>
            : <span />}
          {onDownload && <button type="button" onClick={onDownload} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-brand-text"><Download className="size-4" /> Download</button>}
        </div>
      ) : null}

      {/* The list, by day */}
      {loading ? (
        <div className="mx-4 mt-3 rounded-[20px] bg-card border border-border px-4 py-3 flex flex-col gap-3">
          {[0, 1, 2, 3].map(i => <div key={i} className="flex items-center gap-3"><Skeleton className="size-9 rounded-full" /><div className="flex-1"><Skeleton className="h-3.5 w-32 mb-1.5" /><Skeleton className="h-3 w-24" /></div><Skeleton className="h-4 w-14" /></div>)}
        </div>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center text-center px-8 py-12">
          <span className="inline-flex items-center justify-center size-11 rounded-2xl bg-surface border border-border mb-3"><CreditCard className="size-5 text-text-muted" /></span>
          <p className="text-sm font-medium text-text-secondary">No payments here</p>
          <p className="text-xs text-text-muted mt-1">{date === 'all' ? 'Payments you take show up here' : 'Try another date or filter'}</p>
        </div>
      ) : groups.map(([day, list]) => (
        <div key={day} className="mt-3">
          <p className="px-5 mb-1.5 text-[11.5px] font-bold uppercase tracking-[0.06em] text-text-muted">{day}</p>
          <div className="mx-4 rounded-[20px] bg-card border border-border overflow-hidden divide-y divide-border">
            {list.map(p => <PaymentRow key={p.id} payment={p} onClick={onPayment} />)}
          </div>
        </div>
      ))}
    </div>
  )
}
