// Business tab - its own screens. Every action on the Business tab opens one
// of these over the tab instead of sending the merchant to another page:
//
//   ShopQrScreen      the store's fixed QR (customer types the amount)
//   ReceiveScreen     an amount (keypad) or an itemised bill -> one order shown
//                     as a counter QR and a link to send, live until it's paid
//   RequestsScreen    everything the store asked for, with cancel / complete
//   ReportsScreen     Insights (the selected period by day, hour, customer and
//                     chain) and Statement (CSV / PDF), one screen
//   ProfileScreen     business details and approval (the application form)
//
// Visuals come from the Arc Studio kit in ./ui; this file holds the logic.
// Money in uses the merchant-pay service (payment requests, live status);
// nothing here moves funds out.
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { Store, ChevronDown, Clock, Printer } from 'lucide-react'
import { useAuthStore, useUIStore } from '@/store'
import { useMerchant, applyForMerchant } from '@/lib/merchant'
import { chainLogoSrc } from '@/lib/chainLogos'
import {
  createPaymentRequest, listMyIntents, cancelPayment, completeOrder, paymentLink, watchPayment, invoiceTotal,
  type MerchantIntent, type MerchantPayment, type PaymentView, type InvoiceItem,
} from '@/lib/merchantPay'
import { speakPayment } from '@/lib/voiceAlerts'
import {
  BusinessScreen, QrCard, AmountKeypad, LiveStatus, ShareLink, Field, TextInput, ChipSelect, BillItemsEditor,
  RequestRow, InsightsChart, RankList, ProfileStatusCard, DetailList, PrimaryBtn, GhostBtn, Skeleton,
  QrSticker, HourChart, StatTriple, StatementView, PrintableStatement, ReceiptCard, HelpView,
  type KeypadKey, type LiveStatusKind, type BillItem, type RequestStatus, type StatusCardTone, type StatementRange,
} from './ui'
import { usePrint } from './printArea'
import { salesByHour, hourLabel, statementRows, rangeLabel, rangeStart, exportPaymentsCsv } from './reports'
import type { MerchantRefund } from '@/lib/merchantRefunds'
import { submitPayment, listUnmatchedDeposits, assignDeposit, type UnmatchedDeposit } from '@/lib/merchantPay'
import { chainLabel } from './settlement'

/** How Charge / Payment link / Bill create requests: the owner's own
 *  (createPaymentRequest, for the active store) or, in staff mode, one that
 *  pays the business they work for (staff_create_request). */
type RequestInput = Parameters<typeof createPaymentRequest>[0]
export const RequestMaker = createContext<{ create: (p: RequestInput) => Promise<MerchantIntent>; storeId: string | null; canBill: boolean }>({
  create: createPaymentRequest, storeId: null, canBill: true,
})
function useMakeRequest() {
  const m = useContext(RequestMaker)
  return (p: RequestInput) => m.create({ ...p, storeId: p.storeId ?? m.storeId })
}

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const OPEN = new Set(['pending', 'payment_detected', 'processing', 'partially_paid'])
const isExpired = (i: { expiresAt: string | null; status: string }) => !!i.expiresAt && Date.parse(i.expiresAt) < Date.now() && i.status !== 'paid'

// ── Shared logic ─────────────────────────────────────────────────────────

function useQr(value: string | null) {
  const [src, setSrc] = useState<string>()
  useEffect(() => {
    setSrc(undefined)
    if (!value) return
    let live = true
    QRCode.toDataURL(value, { width: 464, margin: 1, color: { dark: '#0B0E11', light: '#FFFFFF' }, errorCorrectionLevel: 'M' })
      .then(u => { if (live) setSrc(u) }).catch(() => {})
    return () => { live = false }
  }, [value])
  return src
}

function useShare() {
  const toast = useUIStore(s => s.showToastMessage)
  const [copied, setCopied] = useState(false)
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1600) }
    catch { toast('Could not copy', 'error') }
  }
  const share = async (text: string, url: string) => {
    if (navigator.share) { try { await navigator.share({ text, url }) } catch { /* closed */ } return }
    void copy(`${text} ${url}`)
  }
  return { copied, copy, share }
}

function LinkShare({ url, text }: { url: string; text: string }) {
  const { copied, copy, share } = useShare()
  return <ShareLink url={url} copied={copied} onCopy={() => copy(url)} onShare={() => share(text, url)} />
}

/** Live status of one request (polls until it's final). */
function useLiveRequest(code: string | null) {
  const [view, setView] = useState<PaymentView | null>(null)
  useEffect(() => {
    setView(null)
    if (!code) return
    return watchPayment(code, setView, 3000)
  }, [code])
  return view
}

function liveStatus(v: PaymentView | null): { status: LiveStatusKind; text: string } {
  const s = v?.status ?? 'pending'
  if (s === 'paid') return { status: 'paid', text: `Paid ${money(v!.received)}` }
  if (s === 'partially_paid') return { status: 'partial', text: `Received ${money(v!.received)} of ${money(v!.amount)}` }
  if (s === 'payment_detected' || s === 'processing') return { status: 'detected', text: 'Payment found - confirming' }
  if (s === 'expired') return { status: 'expired', text: 'This request expired' }
  if (s === 'cancelled') return { status: 'cancelled', text: 'Cancelled' }
  if (s === 'failed') return { status: 'failed', text: 'Payment failed' }
  return { status: 'waiting', text: 'Waiting for payment' }
}
const Live = ({ view }: { view: PaymentView | null }) => <LiveStatus {...liveStatus(view)} />

function Done({ icon, top, amount, note, children }: { icon: React.ReactNode; top?: string; amount: number; note?: string | null; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center px-5 pt-6 gap-4">
      <span className="inline-flex items-center justify-center size-12 rounded-2xl bg-brand/10 text-brand-text">{icon}</span>
      <div>
        {top && <p className="text-sm text-text-muted">{top}</p>}
        <p className="display text-3xl font-bold tabular-nums text-text-primary">{money(amount)}</p>
        {note && <p className="text-sm text-text-secondary mt-1">{note}</p>}
      </div>
      {children}
    </div>
  )
}

// ── Shop QR ──────────────────────────────────────────────────────────────

export function ShopQrScreen({ open, onBack, storeName, outlet, handle, payTo }: { open: boolean; onBack: () => void; storeName: string; outlet?: string | null; handle: string; payTo?: string }) {
  // payTo: whose pay link (staff mode: the business owner's, never the staff's own).
  // The QR names the outlet (?store=) so each store's payments land in that
  // store; it changes as soon as the owner switches stores.
  const own = useAuthStore(s => s.username)
  const { storeId } = useContext(RequestMaker)
  const username = payTo ?? own
  const url = `${window.location.origin}/paylink/${username ?? ''}${storeId ? `?store=${storeId}` : ''}`
  const qr = useQr(open && username ? url : null)
  const sticker = usePrint()
  const sub = outlet ? `${outlet} · ${handle}` : handle
  return (
    <BusinessScreen open={open} title="Shop QR" onBack={onBack}>
      <div className="flex flex-col items-center text-center px-5 pt-6 gap-5">
        <span className="inline-flex items-center justify-center size-12 rounded-2xl bg-brand/10 text-brand-text"><Store className="size-5" /></span>
        <QrCard dataUrl={qr} title={storeName} subtitle={sub} />
        <p className="text-xs text-text-muted max-w-[260px]">Customers scan, type the amount and pay. USDC from Arc or any CCTP chain is accepted{outlet ? ` and counted for ${outlet}` : ''}.</p>
        <div className="w-full"><LinkShare url={url} text={`Pay ${storeName} on MeshPort`} /></div>
        <GhostBtn disabled={!qr} onClick={() => sticker.print(<QrSticker dataUrl={qr} storeName={outlet ? `${storeName} · ${outlet}` : storeName} handle={handle} />)}>
          <span className="inline-flex items-center gap-2"><Printer className="size-4" /> Print counter sticker</span>
        </GhostBtn>
      </div>
      {sticker.portal}
    </BusinessScreen>
  )
}

// ── Receive (counter QR + shareable link, one order) ─────────────────────

const VALID_FOR = [
  { id: '15', label: '15 min' }, { id: '60', label: '1 hour' }, { id: '1440', label: '1 day' },
  { id: '10080', label: '7 days' }, { id: '0', label: 'No limit' },
]

const blank = (): BillItem => ({ name: '', qty: 1, price: '' })

export function ReceiveScreen({ open, onBack, storeName }: { open: boolean; onBack: () => void; storeName: string }) {
  const make = useMakeRequest()
  // Cashiers take counter payments only: up to an hour, no named customer, no bills.
  const { canBill } = useContext(RequestMaker)
  const validFor = canBill ? VALID_FOR : VALID_FOR.slice(0, 2)
  const toast = useUIStore(s => s.showToastMessage)
  const [itemised, setItemised] = useState(false)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [rows, setRows] = useState<BillItem[]>([blank()])
  const [customer, setCustomer] = useState('')
  const [expiry, setExpiry] = useState('15')
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [intent, setIntent] = useState<MerchantIntent | null>(null)
  const view = useLiveRequest(intent?.code ?? null)
  const link = intent ? paymentLink(intent.code) : null
  const qr = useQr(link)
  const paid = view?.status === 'paid'

  useEffect(() => { if (paid) speakPayment(view!.received) }, [paid])
  const reset = () => {
    setItemised(false); setAmount(''); setNote(''); setRows([blank()]); setCustomer(''); setExpiry('15'); setMore(false); setIntent(null)
  }
  useEffect(() => { if (!open) reset() }, [open])
  // A bill usually goes to someone later: open for 7 days by default.
  const toggleItems = (on: boolean) => { setItemised(on); setExpiry(on ? '10080' : '15') }

  const press = (k: KeypadKey) => setAmount(a => {
    if (k === 'del') return a.slice(0, -1)
    if (k === '.') return a.includes('.') ? a : (a || '0') + '.'
    const next = a === '0' ? k : a + k
    return /\.\d{3,}$/.test(next) || Number(next) > 100000 ? a : next
  })
  const items: InvoiceItem[] = rows.map(r => ({ name: r.name, qty: r.qty, price: Number(r.price) || 0 })).filter(i => i.name.trim() && i.qty > 0)
  const value = itemised ? invoiceTotal(items) : Number(amount) || 0
  const validLabel = validFor.find(v => v.id === expiry)?.label ?? '15 min'

  const create = async () => {
    setBusy(true)
    try {
      setIntent(await make({ amount: value, ...(itemised ? { items } : {}), note: note || undefined,
        customer: canBill && customer ? customer : undefined, expiresInMinutes: Number(expiry) || null }))
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not create the payment', 'error') }
    setBusy(false)
  }
  const cancel = async () => {
    if (intent && view && OPEN.has(view.status)) await cancelPayment(intent.code).catch(() => {})
    setIntent(null)
  }

  if (intent) return (
    <BusinessScreen open={open} title={intent.kind === 'invoice' ? 'Bill' : 'Receive'} onBack={onBack}
      footer={paid ? <PrimaryBtn onClick={reset}>New payment</PrimaryBtn> : <GhostBtn onClick={cancel}>Cancel payment</GhostBtn>}>
      <div className="flex flex-col items-center text-center px-5 pt-5 gap-4">
        <div>
          <p className="text-xs font-semibold text-text-muted uppercase tracking-widest">
            {intent.kind === 'invoice' ? `Bill ${intent.orderNumber ?? ''}` : 'Amount due'}
          </p>
          <p className="display text-4xl font-bold tabular-nums text-text-primary mt-1">{money(intent.amount)}</p>
          {intent.note && <p className="text-sm text-text-secondary mt-1">{intent.note}</p>}
          {intent.customerUsername && <p className="text-xs text-text-muted mt-1">For {intent.customerUsername}.arc</p>}
        </div>
        {intent.kind === 'invoice' && (
          <div className="w-full text-left"><DetailList rows={(intent.items ?? items).map(i => ({ label: `${i.name} × ${i.qty}`, value: money(i.total ?? i.qty * i.price) }))} /></div>
        )}
        <QrCard dataUrl={qr} paid={paid} subtitle={paid ? undefined : `Scan to pay · valid ${intent.expiresAt ? validLabel : 'until paid'}`} />
        <Live view={view} />
        {!paid && link && (
          <div className="w-full">
            <p className="text-xs text-text-muted mb-2">Customer not here? Send the link</p>
            <LinkShare url={link} text={`${storeName}: ${intent.kind === 'invoice' ? `bill ${intent.orderNumber ?? ''} for` : 'pay'} ${money(intent.amount)}${intent.note ? ` - ${intent.note}` : ''}`} />
          </div>
        )}
      </div>
    </BusinessScreen>
  )

  return (
    <BusinessScreen open={open} title="Receive" onBack={onBack}
      footer={<PrimaryBtn disabled={!(value > 0) || busy} onClick={create}>
        {busy ? 'Creating…' : value > 0 ? `${itemised ? 'Create bill' : 'Receive'} ${money(value)}` : itemised ? 'Add items' : 'Enter amount'}</PrimaryBtn>}>
      {canBill && (
        <div className="px-5 pt-4">
          <div className="flex p-1 rounded-2xl bg-surface border border-border" role="tablist" aria-label="Receive type">
            {[{ on: false, label: 'Amount' }, { on: true, label: 'Itemised bill' }].map(t => (
              <button key={t.label} type="button" role="tab" aria-selected={itemised === t.on} onClick={() => toggleItems(t.on)}
                className={`flex-1 min-h-[40px] rounded-xl text-sm font-semibold transition-colors ${itemised === t.on ? 'bg-card text-text-primary shadow-sm' : 'text-text-muted'}`}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {itemised ? (
        <div className="flex flex-col gap-5 px-5 pt-5">
          <Field label="Items"><BillItemsEditor rows={rows} onChange={r => setRows(r.slice(0, 50))} total={money(value)} /></Field>
          <Field label="Note (optional)"><TextInput value={note} onChange={e => setNote(e.target.value)} maxLength={140} placeholder="Thanks for shopping with us" /></Field>
        </div>
      ) : (
        <AmountKeypad value={amount} onKey={press} note={note} onNote={setNote} />
      )}
      <div className="px-5 pt-5 pb-2">
        <button type="button" onClick={() => setMore(m => !m)} aria-expanded={more}
          className="w-full flex items-center justify-between min-h-[48px] px-4 rounded-2xl bg-card border border-border text-sm">
          <span className="text-text-secondary">Valid for <b className="font-semibold text-text-primary">{validLabel}</b>{canBill && customer ? <> · for <b className="font-semibold text-text-primary">{customer.replace(/\.arc$/, '')}.arc</b></> : null}</span>
          <ChevronDown className={`size-4 text-text-muted transition-transform ${more ? 'rotate-180' : ''}`} />
        </button>
        {more && (
          <div className="flex flex-col gap-4 pt-4">
            <Field label="Valid for"><ChipSelect options={validFor} value={expiry} onChange={setExpiry} /></Field>
            {canBill && (
              <Field label="Customer (optional)" hint="Their MeshPort username - they get it in their notifications.">
                <TextInput value={customer} onChange={e => setCustomer(e.target.value)} placeholder="username.arc" />
              </Field>
            )}
          </div>
        )}
      </div>
    </BusinessScreen>
  )
}

// ── Requests ─────────────────────────────────────────────────────────────

const FILTERS = [{ id: 'open', label: 'Open' }, { id: 'paid', label: 'Paid' }, { id: 'all', label: 'All' }]

function requestStatus(i: MerchantIntent): RequestStatus {
  if (i.status === 'paid') return i.completedByMerchant ? 'completed' : 'paid'
  if (i.status === 'cancelled' || i.status === 'failed') return 'cancelled'
  if (i.status === 'expired' || isExpired(i)) return 'expired'
  return i.status === 'partially_paid' ? 'part' : 'open'
}

export function RequestsScreen({ open, onBack }: { open: boolean; onBack: () => void }) {
  const toast = useUIStore(s => s.showToastMessage)
  const [list, setList] = useState<MerchantIntent[] | null>(null)
  const [filter, setFilter] = useState('open')
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const { copy } = useShare()

  const load = () => listMyIntents(200).then(setList).catch(() => setList([]))
  useEffect(() => { if (open) { setList(null); void load() } }, [open])

  const shown = (list ?? []).filter(i => {
    const s = requestStatus(i)
    return filter === 'all' || (filter === 'paid' ? s === 'paid' || s === 'completed' : s === 'open' || s === 'part')
  })
  const act = async (i: MerchantIntent, what: 'cancel' | 'complete') => {
    setBusy(i.id)
    try {
      await (what === 'cancel' ? cancelPayment(i.code) : completeOrder(i.code))
      toast(what === 'cancel' ? 'Request cancelled' : 'Marked as completed', 'success')
      await load()
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not update', 'error') }
    setBusy(null)
  }

  return (
    <BusinessScreen open={open} title="Requests" onBack={onBack}>
      <div className="px-5 pt-4 pb-4"><ChipSelect options={FILTERS} value={filter} onChange={setFilter} /></div>
      <div className="px-5 pb-6">
        {list === null ? (
          <div className="flex flex-col gap-3">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
        ) : shown.length === 0 ? (
          <div className="flex flex-col items-center text-center py-16">
            <span className="inline-flex items-center justify-center size-12 rounded-2xl bg-surface border border-border mb-3"><Clock className="size-5 text-text-muted" /></span>
            <p className="text-sm font-medium text-text-secondary">{filter === 'open' ? 'No open requests' : filter === 'paid' ? 'Nothing paid yet' : 'No requests yet'}</p>
            <p className="text-xs text-text-muted mt-1">Charges, links and bills you create show up here.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {shown.map(i => {
              const status = requestStatus(i)
              const live = status === 'open' || status === 'part'
              return (
                <RequestRow key={i.id} kind={i.kind} status={status} amount={money(i.amount)}
                  title={i.note || (i.kind === 'invoice' ? 'Bill' : 'Payment request')}
                  sub={[i.orderNumber, i.customerUsername && `${i.customerUsername}.arc`, new Date(i.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })].filter(Boolean).join(' · ')}
                  expanded={openId === i.id} onToggle={() => setOpenId(openId === i.id ? null : i.id)}
                  actions={[
                    { label: 'Copy link', tone: 'neutral', onClick: () => { void copy(paymentLink(i.code)); toast('Link copied', 'success') } },
                    ...(live ? [
                      { label: 'Mark completed', tone: 'brand' as const, onClick: () => act(i, 'complete'), disabled: busy === i.id },
                      { label: 'Cancel', tone: 'danger' as const, onClick: () => act(i, 'cancel'), disabled: busy === i.id },
                    ] : []),
                  ]} />
              )
            })}
          </div>
        )}
      </div>
    </BusinessScreen>
  )
}

// ── Insights ─────────────────────────────────────────────────────────────

function InsightsBody({ payments, waiting, period, scope }: {
  payments: MerchantPayment[]; waiting: string
  /** The Business date filter - Insights reads the same range. */
  period: { from: Date; to: Date; label: string }
  /** Active store name when the owner has picked one. */
  scope?: string | null
}) {
  const data = useMemo(() => {
    const from = period.from.getTime(), to = period.to.getTime()
    const list = payments.filter(p => { const t = Date.parse(p.createdAt); return t >= from && t < to })
    const total = list.reduce((s, p) => s + p.amount, 0)
    const rank = (key: (p: MerchantPayment) => string) => {
      const m = new Map<string, { total: number; count: number }>()
      for (const p of list) { const k = key(p); const v = m.get(k) ?? { total: 0, count: 0 }; v.total += p.amount; v.count++; m.set(k, v) }
      return [...m.entries()].sort((a, b) => b[1].total - a[1].total)
    }
    const hours = salesByHour(list)
    const peak = hours.indexOf(Math.max(...hours))
    // Bars across the range: 3-hour blocks for a day, days up to two weeks,
    // weeks up to two months, then months.
    const days = Math.max(1, Math.round((to - from) / 86_400_000))
    const step = days <= 1 ? 3 * 3_600_000 : days <= 14 ? 86_400_000 : days <= 62 ? 7 * 86_400_000 : 0
    const buckets: { start: number; end: number; label: string }[] = []
    if (step) {
      for (let t = from; t < to; t += step) {
        const d = new Date(t)
        buckets.push({ start: t, end: Math.min(t + step, to),
          label: days <= 1 ? hourLabel(d.getHours()) : days <= 14 ? (days <= 7 ? d.toLocaleDateString([], { weekday: 'short' }) : String(d.getDate()))
            : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) })
      }
    } else {
      for (let d = new Date(period.from); d.getTime() < to; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
        const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
        buckets.push({ start: d.getTime(), end: Math.min(end, to), label: d.toLocaleDateString([], { month: 'short' }) })
      }
    }
    return {
      total, count: list.length,
      hours: hours.map((v, h) => ({ label: hourLabel(h), value: v, display: money(v) })),
      peak: hours[peak] > 0 ? `Busiest: ${hourLabel(peak)}` : undefined,
      buyers: new Set(list.map(p => p.customerUsername || p.from.toLowerCase())).size,
      bars: buckets.map(b => {
        const v = list.filter(p => { const t = Date.parse(p.createdAt); return t >= b.start && t < b.end }).reduce((s, p) => s + p.amount, 0)
        return { label: b.label, value: v, display: money(v) }
      }),
      customers: rank(p => p.customerUsername ? `${p.customerUsername}.arc` : /^0x0{40}$/i.test(p.from) ? 'Bridge payment' : `${p.from.slice(0, 6)}…${p.from.slice(-4)}`).slice(0, 5)
        .map(([name, v]) => ({ id: name, left: name, sub: `${v.count} payment${v.count === 1 ? '' : 's'}`, right: money(v.total) })),
      chains: rank(p => p.chain).map(([id, v]) => ({ id, left: chainLabel(id), logo: chainLogoSrc(id), sub: `${Math.round((v.total / (total || 1)) * 100)}% of sales`, right: money(v.total) })),
    }
  }, [payments, period.from.getTime(), period.to.getTime()])

  const label = scope ? `${period.label} · ${scope}` : period.label
  return (
      <div className="flex flex-col gap-6 px-5 pt-4 pb-6">
        <InsightsChart total={money(data.total)} sub={`${label} · ${data.count} payment${data.count === 1 ? '' : 's'}`} bars={data.bars} />
        <StatTriple items={[
          { label: 'Average ticket', value: money(data.count ? data.total / data.count : 0) },
          { label: 'Waiting to settle', value: waiting },
          { label: 'Customers', value: String(data.buyers), hint: period.label.toLowerCase() },
        ]} />
        <HourChart title="Sales by hour" sub={period.label} bars={data.hours} peak={data.peak} />
        <RankList title="Top customers" empty="No customers in this period" rows={data.customers} />
        <RankList title="By chain" empty="No payments in this period" rows={data.chains} />
      </div>
  )
}

// ── Business profile / approval ──────────────────────────────────────────

export function ProfileScreen({ open, onBack, handle }: { open: boolean; onBack: () => void; handle: string }) {
  const toast = useUIStore(s => s.showToastMessage)
  const { status, application } = useMerchant()
  const [contact, setContact] = useState(() => application?.contact || '')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [again, setAgain] = useState(false)

  const closed = status === 'rejected' || status === 'revoked'
  const canApply = status === 'none' || (closed && again)
  const submit = async () => {
    setBusy(true)
    // The business is its username; shops are added as stores after approval.
    try { await applyForMerchant({ businessName: handle, contact, description: reason }); toast('Sent for review', 'success'); setAgain(false) }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not send', 'error') }
    setBusy(false)
  }

  const card: { tone: StatusCardTone; title: string; text: string } =
    status === 'approved' ? { tone: 'success', title: 'Verified business', text: 'All merchant tools are on. Add your shops in Stores & staff.' }
    : status === 'pending' ? { tone: 'warning', title: 'Under review', text: "MeshPort is reviewing your business. You'll get a notification when it's approved." }
    : closed ? { tone: 'danger', title: status === 'revoked' ? 'Merchant access removed' : 'Not approved', text: application?.reviewNote || 'Check the details and send it again.' }
    : { tone: 'brand', title: 'Complete your business account', text: 'Tell MeshPort why you need a business account. Once approved, you can add your stores.' }

  return (
    <BusinessScreen open={open} title="Business profile" onBack={onBack}
      footer={canApply ? <PrimaryBtn disabled={busy || reason.trim().length < 10} onClick={submit}>{busy ? 'Sending…' : 'Send for review'}</PrimaryBtn>
        : closed ? <PrimaryBtn onClick={() => setAgain(true)}>Apply again</PrimaryBtn> : undefined}>
      <div className="flex flex-col gap-6 px-5 pt-5 pb-6">
        <ProfileStatusCard {...card} />
        {canApply ? (
          <>
            <Field label="Why do you need a business account?" hint={`${reason.trim().length}/10 characters minimum`}>
              <textarea value={reason} onChange={e => setReason(e.target.value)} maxLength={500} rows={4}
                placeholder="e.g. I run a bakery and want customers to pay in USDC at the counter."
                className="w-full rounded-2xl bg-surface border border-border px-4 py-3 text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-brand resize-none" />
            </Field>
            <Field label="Contact (optional)"><TextInput value={contact} onChange={e => setContact(e.target.value)} maxLength={120} placeholder="Phone or email" /></Field>
          </>
        ) : (
          <DetailList rows={[
            { label: 'Business', value: handle },
            ...(application?.contact ? [{ label: 'Contact', value: application.contact }] : []),
            ...(application ? [{ label: 'Applied', value: new Date(application.createdAt).toLocaleDateString() }] : []),
          ]} />
        )}
      </div>
    </BusinessScreen>
  )
}

// ── Statement ────────────────────────────────────────────────────────────

function StatementBody({ storeName, handle, payments, refunds, settled, waiting, loading }: {
  storeName: string; handle: string; payments: MerchantPayment[]; refunds: MerchantRefund[]
  settled: { amount: number; createdAt: string }[]; waiting: number; loading: boolean
}) {
  const [range, setRange] = useState<StatementRange>('today')
  const printer = usePrint()
  const rows = statementRows({ range, payments, refunds, settled, waiting })
  const since = rangeStart(range).getTime()
  const inRange = payments.filter(p => Date.parse(p.createdAt) >= since)
  const refunded = new Set(refunds.map(r => r.paymentId))
  const name = (p: MerchantPayment) => p.customerUsername ? `${p.customerUsername}.arc` : `${p.from.slice(0, 6)}…${p.from.slice(-4)}`
  const pdf = () => printer.print(
    <PrintableStatement storeName={storeName} handle={handle} periodLabel={rangeLabel(range)} rows={rows}
      payments={inRange.map(p => ({ time: p.createdAt, from: name(p), order: p.orderNumber ?? undefined, chain: chainLabel(p.chain), amount: money(p.amount), status: refunded.has(p.id) ? 'Refunded' : 'Paid' }))} />)
  return (
    <>
      <div className="px-5 pt-4 pb-6">
        <StatementView range={range} onRange={setRange} loading={loading} rows={rows} periodLabel={rangeLabel(range)}
          onCsv={() => exportPaymentsCsv(inRange, storeName, refunds)} onPdf={pdf} />
      </div>
      {printer.portal}
    </>
  )
}

// ── Reports: Insights + Statement ────────────────────────────────────────

export function ReportsScreen({ open, onBack, insights, statement }: {
  open: boolean; onBack: () => void
  insights: Parameters<typeof InsightsBody>[0]
  statement: Parameters<typeof StatementBody>[0]
}) {
  const [view, setView] = useState<'insights' | 'statement'>('insights')
  useEffect(() => { if (!open) setView('insights') }, [open])
  return (
    <BusinessScreen open={open} title="Reports" onBack={onBack}>
      <div className="px-5 pt-4">
        <div className="flex p-1 rounded-2xl bg-surface border border-border" role="tablist" aria-label="Report">
          {([['insights', 'Insights'], ['statement', 'Statement']] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}
              className={`flex-1 min-h-[40px] rounded-xl text-sm font-semibold transition-colors ${view === id ? 'bg-card text-text-primary shadow-sm' : 'text-text-muted'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {view === 'insights' ? <InsightsBody {...insights} /> : <StatementBody {...statement} />}
    </BusinessScreen>
  )
}

// ── Receipt ──────────────────────────────────────────────────────────────

export function ReceiptScreen({ open, onBack, storeName, handle, payment, refunded }: {
  open: boolean; onBack: () => void; storeName: string; handle: string; payment: MerchantPayment | null; refunded: boolean
}) {
  const printer = usePrint()
  const { share } = useShare()
  if (!payment) return <BusinessScreen open={false} title="Receipt" onBack={onBack}>{null}</BusinessScreen>
  const from = payment.customerUsername ? `${payment.customerUsername}.arc` : `${payment.from.slice(0, 6)}…${payment.from.slice(-4)}`
  const card = (printable: boolean) => (
    <ReceiptCard storeName={storeName} handle={handle} amount={money(payment.amount)} from={from} chainLabel={chainLabel(payment.chain)}
      order={payment.orderNumber ?? undefined} time={payment.createdAt} txHash={payment.txHash} refunded={refunded} printable={printable} />
  )
  const text = [`Receipt from ${storeName} (${handle})`, `${money(payment.amount)} USDC${refunded ? ' - refunded' : ''}`,
    payment.orderNumber ? `Order ${payment.orderNumber}` : '', `Paid by ${from} on ${chainLabel(payment.chain)}`,
    new Date(payment.createdAt).toLocaleString(), `Transaction ${payment.txHash}`].filter(Boolean).join('\n')
  return (
    <BusinessScreen open={open} title="Receipt" onBack={onBack}
      footer={<div className="grid grid-cols-2 gap-3">
        <GhostBtn onClick={() => printer.print(card(true))}>Print</GhostBtn>
        <PrimaryBtn onClick={() => share(text, `${window.location.origin}/paylink/${handle.replace(/\.arc$/, '')}`)}>Send receipt</PrimaryBtn>
      </div>}>
      <div className="px-5 pt-5 pb-6 flex justify-center">{card(false)}</div>
      {printer.portal}
    </BusinessScreen>
  )
}

// ── Help & disputes ──────────────────────────────────────────────────────

const HELP_CHAINS = ['Arc_Testnet', 'Base_Sepolia', 'Ethereum_Sepolia', 'Arbitrum_Sepolia', 'Optimism_Sepolia', 'Polygon_Sepolia', 'Avalanche_Fuji']
const FAQ = [
  { q: 'A customer says they paid but nothing shows', a: 'Ask for the transaction hash (it is in their wallet history), pick the chain and the order, then Check & attach. MeshPort reads it from the chain and adds it to the order if it paid your wallet.' },
  { q: 'A payment came in without an order', a: 'It shows under "Payments without an order". Pick the open order it belongs to and tap Assign.' },
  { q: 'How do I refund?', a: 'Open the payment in Payments and tap Refund. The USDC goes back to the customer from your Arc balance through the MeshPort refunds contract, once per payment.' },
  { q: 'When does money from other chains reach Arc?', a: 'When you settle. Settlements moves it over CCTP and MeshPort pays the gas; it usually arrives in a few minutes.' },
]

export function HelpScreen({ open, onBack }: { open: boolean; onBack: () => void }) {
  const toast = useUIStore(s => s.showToastMessage)
  const [chain, setChain] = useState('Arc_Testnet')
  const [txHash, setTxHash] = useState('')
  const [orders, setOrders] = useState<MerchantIntent[]>([])
  const [order, setOrder] = useState('')
  const [unmatched, setUnmatched] = useState<UnmatchedDeposit[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ tone: 'success' | 'danger' | 'warning'; title: string; text: string }>()

  const load = () => {
    listMyIntents(200).then(l => {
      const open = l.filter(i => OPEN.has(i.status) && !isExpired(i))
      setOrders(open); setOrder(o => o || open[0]?.code || '')
    }).catch(() => {})
    listUnmatchedDeposits().then(setUnmatched).catch(() => setUnmatched([]))
  }
  useEffect(() => { if (open) { setResult(undefined); load() } }, [open])

  const check = async () => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash.trim())) { setResult({ tone: 'warning', title: 'Check the hash', text: 'A transaction hash starts with 0x and has 64 characters after it.' }); return }
    if (!order) { setResult({ tone: 'warning', title: 'Pick an order', text: 'Choose the open order this payment was for.' }); return }
    setBusy(true); setResult(undefined)
    try {
      const v = await submitPayment(order, chain, txHash.trim(), { merchantVerify: true })
      setResult(v.status === 'paid' || v.status === 'processing' || v.status === 'partially_paid'
        ? { tone: 'success', title: 'Payment found', text: `${money(v.received)} attached to ${v.orderNumber ?? 'the order'}.` }
        : { tone: 'warning', title: 'Still checking', text: 'The transaction is not confirmed yet. Try again in a minute.' })
      load()
    } catch (e) {
      setResult({ tone: 'danger', title: 'Not a payment to you', text: e instanceof Error ? e.message : 'MeshPort could not match this transaction.' })
    }
    setBusy(false)
  }
  const assign = async (id: string) => {
    if (!order) { toast('Pick an open order first', 'error'); return }
    try { await assignDeposit(id, order); toast('Payment assigned', 'success'); load() }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not assign', 'error') }
  }

  return (
    <BusinessScreen open={open} title="Help & disputes" onBack={onBack}>
      <div className="px-5 pt-5 pb-6">
        <HelpView chains={HELP_CHAINS.map(id => ({ id, label: chainLabel(id), logo: chainLogoSrc(id) }))} chain={chain} onChain={setChain}
          txHash={txHash} onTxHash={setTxHash}
          orders={orders.map(i => ({ code: i.code, label: `${i.orderNumber ?? 'Order'} · ${money(i.amount - i.received)}` }))} order={order} onOrder={setOrder}
          busy={busy} result={result} onCheck={check}
          unmatched={unmatched.map(u => ({ id: u.id, amount: money(u.amount), from: `${u.from.slice(0, 6)}…${u.from.slice(-4)}`, chainLabel: chainLabel(u.chain), when: u.createdAt }))}
          onAssign={id => { void assign(id) }} faq={FAQ} />
      </div>
    </BusinessScreen>
  )
}
