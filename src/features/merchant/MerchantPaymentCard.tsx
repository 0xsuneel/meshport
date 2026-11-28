// Payment request / bill card shown inside a chat message that contains a
// /paylink/r/<code> link (or an older /pay/r/<code> one). Chat stays messaging; the card reads the live status
// of the linked request (Manage money is the financial record).
//
// Everything happens inside the conversation - no separate page:
//   • Customer taps "Pay invoice" → the chat's own pay sheet opens with the
//     bill's amount and short bill number (see ChatPage's BILL_PAY_EVENT).
//   • Once paid, the customer's payment appears in chat as a reply to this
//     card, and this card turns into "Payment received" (merchant) /
//     "Paid" (customer). A paid or closed card can't be opened or paid again.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { splitForCode, type SplitSummary } from '@/lib/splits'
import { CheckCircle2, Clock, Receipt } from 'lucide-react'
import { AnimatePresence } from 'framer-motion'
import { cardInnerWidth } from '@/features/chat/chatCard'
import { formatAmount } from '@/lib/utils'
import { useBillDetails } from './useBillDetails'
import { dueText } from '@/lib/businessBills'
import { TxDetailPage, type TxDetail, type TxParty } from '@/components/ui/TxDetailPage'
import { arcExplorerTxUrl, ARC_CHAIN_KEY } from '@/lib/chainExplorers'
import {
  watchPayment, getPayment, withLocalPayment, orderLabel, orderKindOf, orderTitle, expiryText, STATUS_LABEL, BILL_PAY_EVENT, BILL_UPDATED_EVENT, type PaymentView,
  billLines,
} from '@/lib/merchantPay'

const CHAIN_LABEL: Record<string, string> = {
  Arc_Testnet: 'Arc', Ethereum_Sepolia: 'Ethereum', Base_Sepolia: 'Base', Arbitrum_Sepolia: 'Arbitrum', Optimism_Sepolia: 'Optimism',
  Polygon_Sepolia: 'Polygon', Avalanche_Fuji: 'Avalanche', HyperEVM_Testnet: 'HyperEVM', Sei_Testnet: 'Sei', Unichain_Sepolia: 'Unichain',
}

/**
 * The card as far as the chat message itself tells us (order number, amount,
 * items, note) - drawn at once so the bubble is never empty while the live
 * status loads (or if loading fails on a weak connection).
 *   🧾 Bill · Order #ORD-100008 · $20.6 USDC\nShoes × 1, Shirt × 1\nnote\nlink
 *   💸 Payment request · Order #ORD-100010 · $5.3 USDC\nnote\nlink
 */
export function paymentViewFromText(code: string, text: string): PaymentView | null {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean).filter(l => !/\/pay(?:link)?\/r\//i.test(l))
  const m = /^(🧾 Bill|💸 Payment request)(?: · Order #([A-Z0-9-]{3,20}))? · \$([\d.,]+) USDC/u.exec(lines[0] ?? '')
  if (!m) return null
  const isBill = m[1].startsWith('🧾')
  const rest = lines.slice(1)
  let items: PaymentView['items'] = null
  if (isBill && rest.length && /\S+ × \d/.test(rest[0])) {
    items = rest.shift()!.split(/,\s*/).map(x => {
      const im = /^(.*) × ([\d.]+)$/.exec(x)
      return { name: im ? im[1] : x, qty: im ? Number(im[2]) : 1, price: NaN, total: NaN }
    })
  }
  return {
    code, orderNumber: m[2] ?? null, merchantName: null, merchantWallet: '', merchantUsername: null, merchantAvatar: null,
    amount: Number(m[3].replace(/,/g, '')), received: 0, currency: 'USDC', note: rest.join(' · ') || null,
    customerUsername: null, status: 'pending', kind: isBill ? 'invoice' : 'request', items,
    createdAt: '', expiresAt: null, paidAt: null, completedByMerchant: false, completedNote: null, chains: [], payments: [],
  } as unknown as PaymentView
}

// Last known live status per bill (memory + localStorage), so a card that
// scrolls back into view or a reopened chat shows its real status straight
// away instead of flicking from "Checking status…" to the live card. The live
// watch below still refreshes it.
const _viewCache = new Map<string, PaymentView>()
const VIEW_KEY = (code: string) => `meshport_bill_${code}`
function cachedView(code: string): PaymentView | null {
  const hit = _viewCache.get(code)
  if (hit) return hit
  try {
    const raw = localStorage.getItem(VIEW_KEY(code))
    if (!raw) return null
    const v = JSON.parse(raw) as PaymentView
    _viewCache.set(code, v)
    return v
  } catch { return null }
}
function rememberView(code: string, v: PaymentView) {
  _viewCache.set(code, v)
  try { localStorage.setItem(VIEW_KEY(code), JSON.stringify(v)) } catch { /* storage full or blocked */ }
}

/** Fetches a bill's live status ahead of time (a chat about to open), so its card is drawn final. */
export function prefetchPaymentView(code: string): Promise<void> {
  if (cachedView(code)) return Promise.resolve()
  return getPayment(code).then(v => rememberView(code, v)).catch(() => {})
}

export function MerchantPaymentCard({ code, isMine, text }: { code: string; isMine: boolean; text?: string }) {
  const [live, setLive] = useState<PaymentView | null>(() => cachedView(code))
  // A payment made in this app counts at once (withLocalPayment); the
  // server's own reading is what gets remembered.
  const setV = (v: PaymentView) => { rememberView(code, v); setLive(withLocalPayment(v)) }
  const [open, setOpen] = useState(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => watchPayment(code, setV, 8000), [code])
  const v = live ?? (text ? paymentViewFromText(code, text) : null)
  const loading = !live
  // Refresh at once when this chat just paid the bill.
  useEffect(() => {
    const onUpdated = (e: Event) => {
      const d = (e as CustomEvent<string | PaymentView | undefined>).detail
      if (d && typeof d === 'object') { if (d.code === code) setV(d); return }
      if (d === code) setLive(cur => cur ? withLocalPayment(cur) : cur)
      if (d === code || d == null) getPayment(code).then(setV).catch(() => {})
    }
    window.addEventListener(BILL_UPDATED_EVENT, onUpdated)
    return () => window.removeEventListener(BILL_UPDATED_EVENT, onUpdated)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately re-runs only on the listed values
  }, [code])
  // A bill's discount and tax name (bill_details) - read once.
  const billInfo = useBillDetails(code, live?.kind === 'invoice' || !!text?.startsWith('🧾'))
  if (!v) return null

  const paid = v.status === 'paid'
  const closed = ['expired', 'cancelled', 'failed'].includes(v.status)
  const isBill = v.kind === 'invoice' && !!v.items?.length
  const number = orderLabel(v)
  const route = v.payments[0]?.chain
  const routeLabel = route ? (route === 'Arc_Testnet' ? 'Arc' : `${CHAIN_LABEL[route] ?? route} → Arc`) : null
  const canPay = !loading && !paid && !closed && !isMine && v.status !== 'processing'
  const pay = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (canPay) window.dispatchEvent(new CustomEvent(BILL_PAY_EVENT, { detail: v }))
  }

  // Colour-band card: the amount on a band that says the state at a glance
  // (amber = due, green = paid, grey = expired / cancelled), items and the
  // Pay button on a strip below. Same width limits as before.
  // Status not known yet (first sight of this bill): a neutral band and no
  // "due" tag, so a bill that turns out paid doesn't flip amber → green.
  const band = loading ? '#66707E'
    : paid ? '#15876F'
    : closed ? '#6C747E'
    : '#B9761F'
  const amountTag = loading ? '' : paid ? 'paid' : closed ? STATUS_LABEL[v.status].toLowerCase() : 'due'
  const statusLine = loading ? 'Checking status…'
    : paid && v.completedByMerchant ? 'Completed'
    : paid ? (isMine ? 'Payment received' : 'Paid')
    : v.status === 'processing' && v.payments.some(p => p.status === 'in_ledger') ? 'Moving to Arc'
    : closed ? 'Can no longer be paid' // the band already says expired / cancelled / failed
    : expiryText(v.expiresAt) && v.status !== 'processing' ? `${STATUS_LABEL[v.status]} · ${expiryText(v.expiresAt)!.replace(/^Expires/, 'expires')}`
    : STATUS_LABEL[v.status]
  const muted = 'var(--text-secondary)'
  // Pay-by date the business set: "Due 25 Oct" / "Due today" / "Overdue 3 days".
  const dueLine = loading ? null : dueText(v.dueDate, !paid && !closed)
  const dueColor = dueLine?.tone === 'danger' ? 'var(--danger)' : dueLine?.tone === 'warning' ? 'var(--warning)' : muted

  return (
    <div id={`order-${number.toLowerCase()}`} role="button" onClick={e => { e.stopPropagation(); setOpen(true) }}
      style={{
        cursor: 'pointer', width: cardInnerWidth(isMine), maxWidth: '100%', marginBottom: 2, borderRadius: 13, overflow: 'hidden',
        background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-primary)',
        boxShadow: '0 6px 16px -10px rgba(0,0,0,0.35)', textAlign: 'left',
      }}>
      {/* Anchor for payment replies sent before order numbers existed. */}
      <span id={`bill-${code.slice(0, 6)}`} />
      <div style={{ position: 'relative', overflow: 'hidden', padding: '13px 13px 14px', color: '#fff', background: band }}>
        <span aria-hidden style={{ position: 'absolute', right: -18, top: -18, width: 72, height: 72, borderRadius: '50%', border: '12px solid rgba(255,255,255,0.12)' }} />
        {paid && (
          // Rubber-stamp "PAID" beside the amount on a settled bill.
          <span aria-label="Paid" style={{
            position: 'absolute', right: 12, bottom: 13, transform: 'rotate(-12deg)',
            padding: '2px 8px', borderRadius: 6, border: '2px solid rgba(255,255,255,0.9)',
            color: '#fff', fontSize: 12, fontWeight: 900, letterSpacing: '0.16em', lineHeight: 1.3,
            background: 'rgba(255,255,255,0.1)', boxShadow: '0 0 0 1px rgba(255,255,255,0.18) inset',
          }}>PAID</span>
        )}
        {/* The order's name wraps rather than being cut ("Request ORD-00042 Received"). */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: 5, fontSize: 12, fontWeight: 700, lineHeight: 1.3, opacity: 0.92 }}>
          <span style={{ flexShrink: 0, display: 'flex', marginTop: 1 }}>{paid ? <CheckCircle2 size={13} /> : isBill ? <Receipt size={13} /> : <Clock size={13} />}</span>
          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
            {orderTitle(orderKindOf(v), number, { paid, received: paid && isMine, short: true, business: v.merchantName })}
          </span>
        </div>
        <div style={{ position: 'relative', fontSize: 22, fontWeight: 800, letterSpacing: '-0.4px', lineHeight: 1.1, marginTop: 3 }}>
          ${formatAmount(v.amount)} {!paid && amountTag && <span style={{ fontSize: 13, fontWeight: 700, opacity: 0.85 }}>{amountTag}</span>}
        </div>
      </div>

      <div style={{ padding: '10px 13px 12px' }}>
        {isBill && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px 10px', fontSize: 12 }}>
            {v.items!.slice(0, 8).map((i, k) => (
              <div key={k} style={{ display: 'contents' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: muted }}>{i.name} × {Number(i.qty)}</span>
                <span style={{ textAlign: 'right', fontWeight: 700 }}>{Number.isFinite(Number(i.total ?? i.qty * i.price)) ? `$${formatAmount(Number(i.total ?? i.qty * i.price))}` : ''}</span>
              </div>
            ))}
            {v.items!.length > 8 && <span style={{ color: muted }}>+{v.items!.length - 8} more</span>}
            {billLines(v.items!, v.amount, v.taxPercent, billInfo).filter(l => l.kind === 'discount' || l.kind === 'tax').map((l, k) => (
              <div key={`l${k}`} style={{ display: 'contents' }}>
                <span style={{ color: muted }}>{l.label}{l.note ? ` (${l.note})` : ''}</span>
                <span style={{ textAlign: 'right', fontWeight: 700 }}>{l.kind === 'discount' ? `− $${formatAmount(-l.amount)}` : `${l.note ? '' : '+ '}$${formatAmount(l.amount)}`}</span>
              </div>
            ))}
            {v.storeTaxId && (
              <div style={{ display: 'contents' }}>
                <span style={{ color: muted }}>Tax ID</span>
                <span style={{ textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>{v.storeTaxId}</span>
              </div>
            )}
          </div>
        )}
        {v.note && <div style={{ fontSize: 12, color: muted, marginTop: isBill ? 5 : 0 }}>{v.note}</div>}
        {/* A share of a split bill (lib/splits): how many have paid, and the whole split. */}
        {!isBill && v.note?.startsWith('Split ·') && <SplitStrip code={code} />}
        {dueLine && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: dueColor, marginTop: (isBill || v.note) ? 6 : 0 }}>
            <Clock size={12} /> {dueLine.text}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12, color: muted, marginTop: (isBill || v.note || dueLine) ? 6 : 0 }}>
          <span style={{ fontWeight: 600, color: paid ? 'var(--success-text)' : muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{statusLine}</span>
          {routeLabel && <span style={{ whiteSpace: 'nowrap' }}>{routeLabel}</span>}
        </div>
        {canPay && (
          <button onClick={pay}
            style={{ width: '100%', marginTop: 8, padding: '9px 0', borderRadius: 10, border: 'none', background: 'var(--text-primary)', color: 'var(--surface)', fontSize: 13, fontWeight: 800, cursor: 'pointer' }}>
            Pay now · ${formatAmount(Math.max(0, v.amount - v.received))}
          </button>
        )}
      </div>
      <AnimatePresence>
      {open && <BillReceipt key="receipt" v={v} isMine={isMine} isBill={isBill} loading={loading} canPay={canPay}
        onPay={() => { setOpen(false); window.dispatchEvent(new CustomEvent(BILL_PAY_EVENT, { detail: v })) }}
        onClose={() => setOpen(false)} />}
      </AnimatePresence>
    </div>
  )
}

function SplitStrip({ code }: { code: string }) {
  const navigate = useNavigate()
  const [s, setS] = useState<SplitSummary | null>(null)
  useEffect(() => {
    let live = true
    const load = () => { void splitForCode(code).then(v => { if (live) setS(v) }) }
    load()
    window.addEventListener(BILL_UPDATED_EVENT, load)
    return () => { live = false; window.removeEventListener(BILL_UPDATED_EVENT, load) }
  }, [code])
  if (!s) return null
  return (
    <button type="button" onClick={e => { e.stopPropagation(); navigate(`/splits/${s.id}`) }}
      style={{ width: '100%', marginTop: 7, padding: 0, border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--text-secondary)' }}>
      <div style={{ height: 5, borderRadius: 9, overflow: 'hidden', background: 'color-mix(in srgb, var(--text-primary) 9%, transparent)' }}>
        <div style={{ height: '100%', width: `${((s.paidCount + 1) / (s.requests + 1)) * 100}%`, background: 'var(--brand)', borderRadius: 9 }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginTop: 4 }}>
        <span>{s.paidCount + 1} of {s.requests + 1} paid · {s.people} people</span>
        <span style={{ fontWeight: 700, color: 'var(--brand-text)' }}>View split ›</span>
      </div>
    </button>
  )
}

// Tapping a bill / payment request card opens it as a receipt: a paid one
// shows the same receipt a live payment ends on ("Payment Received" for the
// merchant who sent it, "Paid Successfully" for the customer); an unpaid one
// shows the bill with what is still due and the Pay button; an expired /
// cancelled / failed one shows why it can no longer be paid.
export function BillReceipt({ v, isMine, isBill, loading, canPay, onPay, onClose }: {
  v: PaymentView; isMine: boolean; isBill: boolean; loading: boolean; canPay: boolean
  onPay: () => void; onClose: () => void
}) {
  const paid = v.status === 'paid'
  const closed = ['expired', 'cancelled', 'failed'].includes(v.status)
  const orderKind = orderKindOf(v)
  const kind = orderKind === 'bill' ? 'Bill' : orderKind === 'merchant_request' ? 'Requested Payment' : orderKind === 'shop' ? 'Payment' : 'Request'
  const number = orderLabel(v)
  const due = Math.max(0, v.amount - v.received)
  const payment = v.payments.find(p => p.txHash) ?? null
  const route = payment?.chain
  const routeLabel = route ? (route === 'Arc_Testnet' ? 'Arc' : `${CHAIN_LABEL[route] ?? route} → Arc`) : null
  const when = (iso: string | null | undefined) => iso
    ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : null
  const status = paid ? 'success' : closed ? 'failed' : 'pending'
  const dueLine = loading ? null : dueText(v.dueDate, !paid && !closed)
  const dueOn = v.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(v.dueDate)
    ? new Date(`${v.dueDate}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null
  const title = paid ? (isMine ? 'Payment Received' : 'Paid Successfully')
    : closed ? `${kind} ${STATUS_LABEL[v.status]}`
    : kind
  const statusText = loading ? 'Checking status…'
    : paid && v.completedByMerchant ? 'Completed by business'
    : v.status === 'processing' && v.payments.some(p => p.status === 'in_ledger') ? 'Moving to Arc'
    : STATUS_LABEL[v.status]
  const hash = payment?.txHash || null
  const explorerHref = hash
    ? (route && route !== ARC_CHAIN_KEY ? null : arcExplorerTxUrl(hash))
    : null

  // The app's history card (19 Nov 2026): the business and the customer, the
  // order as the tag, when it was paid (or made) in the band, the bill's lines
  // under its details - and Pay while there's something still due.
  const bizHandle = v.merchantUsername ? `${v.merchantUsername.replace(/\.arc$/i, '')}.arc` : undefined
  const custHandle = v.customerUsername ? `${v.customerUsername.replace(/\.arc$/i, '')}.arc` : undefined
  const business: TxParty = { label: isMine ? 'To' : (paid ? 'To' : 'From'), name: v.merchantName || (bizHandle ? bizHandle.replace(/\.arc$/i, '') : 'Business'), handle: bizHandle, tag: 'SHOP', ...(isMine ? { you: true } : {}) }
  const customer: TxParty = { label: isMine ? 'From' : (paid ? 'From' : 'To'), name: isMine ? (custHandle ? custHandle.replace(/\.arc$/i, '') : 'Customer') : 'You', handle: custHandle, ...(isMine ? {} : { you: true }) }
  const at = new Date(v.paidAt ?? payment?.createdAt ?? v.createdAt ?? Date.now())
  const whenFull = `${at.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}, ${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
  const detail: TxDetail = {
    title: paid ? 'Payment details' : `${kind} details`,
    status,
    amountLabel: paid ? (isMine ? 'Amount received' : 'Amount paid') : closed ? title : 'Amount due',
    amount: `$${formatAmount(paid || closed ? v.amount : (due || v.amount))}`, unit: v.currency || 'USDC',
    pill: { icon: orderKind === 'shop' ? 'qr' : 'list', text: orderTitle(orderKind, number, { paid, received: paid && isMine, business: v.merchantName }) },
    parties: customer.label === 'From' ? [customer, business] : [business, customer],
    steps: [],
    whenLabel: paid ? (isMine ? 'Received at' : 'Paid at') : 'Created at', when: whenFull,
    hashes: hash ? [{ label: 'Transaction hash', hash }] : [],
    detailsTitle: `${kind} details`,
    details: [
      { label: 'Status', value: statusText, tone: paid ? 'ok' : closed ? 'bad' : undefined },
      ...(v.received > 0 && Math.abs(v.received - v.amount) > 0.000001 ? [{ label: isMine ? 'Received' : 'Paid', value: `$${formatAmount(v.received)} USDC` }] : []),
      ...(!paid && !closed && due > 0 ? [{ label: 'Still due', value: `$${formatAmount(due)} USDC` }] : []),
      ...(dueLine && dueOn ? [{ label: 'Pay by', value: dueLine.tone === 'danger' ? `${dueOn} · ${dueLine.text.toLowerCase()}` : dueOn, tone: dueLine.tone === 'danger' ? 'bad' as const : undefined }] : []),
      ...(isBill && v.items?.length
        ? v.items.map(i => ({
            label: `${i.name} × ${Number(i.qty)}`,
            value: Number.isFinite(Number(i.total ?? i.qty * i.price)) ? `$${formatAmount(Number(i.total ?? i.qty * i.price))}` : '-',
          }))
        : []),
      ...(v.note ? [{ label: 'Note', value: v.note }] : []),
      ...(routeLabel ? [{ label: 'Route', value: routeLabel }] : []),
      ...(when(v.createdAt) ? [{ label: 'Created', value: when(v.createdAt)! }] : []),
      ...(!paid && !closed && when(v.expiresAt) ? [{ label: 'Expires', value: when(v.expiresAt)! }] : []),
      ...(v.completedByMerchant && v.completedNote ? [{ label: 'Business note', value: v.completedNote }] : []),
      ...(hash && explorerHref ? [{ label: 'Explorer', value: 'View on ArcScan', href: explorerHref }] : []),
    ],
    action: canPay ? { label: `${isBill ? 'Pay invoice' : 'Pay'} · $${formatAmount(due)}`, onClick: onPay } : undefined,
    promo: false,
  }
  return <TxDetailPage detail={detail} onClose={onClose} />
}
