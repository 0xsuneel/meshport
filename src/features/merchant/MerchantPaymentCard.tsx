// Payment request / bill card shown inside a chat message that contains a
// /paylink/r/<code> link (or an older /pay/r/<code> one). Chat stays messaging; the card reads the live status
// of the linked request (the Ledger is the financial record).
//
// Everything happens inside the conversation — no separate page:
//   • Customer taps "Pay invoice" → the chat's own pay sheet opens with the
//     bill's amount and short bill number (see ChatPage's BILL_PAY_EVENT).
//   • Once paid, the customer's payment appears in chat as a reply to this
//     card, and this card turns into "Payment received" (merchant) /
//     "Paid" (customer). A paid or closed card can't be opened or paid again.
import { useEffect, useState } from 'react'
import { CheckCircle2, Clock, Receipt } from 'lucide-react'
import { cardInnerWidth } from '@/features/chat/chatCard'
import { formatAmount } from '@/lib/utils'
import { ReceiptPopup } from '@/components/ui/ReceiptPopup'
import {
  watchPayment, getPayment, orderLabel, STATUS_LABEL, BILL_PAY_EVENT, BILL_UPDATED_EVENT, type PaymentView,
} from '@/lib/merchantPay'

const CHAIN_LABEL: Record<string, string> = {
  Arc_Testnet: 'Arc', Ethereum_Sepolia: 'Ethereum', Base_Sepolia: 'Base', Arbitrum_Sepolia: 'Arbitrum', Optimism_Sepolia: 'Optimism',
  Polygon_Sepolia: 'Polygon', Avalanche_Fuji: 'Avalanche', HyperEVM_Testnet: 'HyperEVM', Sei_Testnet: 'Sei', Unichain_Sepolia: 'Unichain',
}

/**
 * The card as far as the chat message itself tells us (order number, amount,
 * items, note) — drawn at once so the bubble is never empty while the live
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

export function MerchantPaymentCard({ code, isMine, text }: { code: string; isMine: boolean; text?: string }) {
  const [live, setLive] = useState<PaymentView | null>(() => cachedView(code))
  const setV = (v: PaymentView) => { rememberView(code, v); setLive(v) }
  const [open, setOpen] = useState(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => watchPayment(code, setV, 8000), [code])
  const v = live ?? (text ? paymentViewFromText(code, text) : null)
  const loading = !live
  // Refresh at once when this chat just paid the bill.
  useEffect(() => {
    const onUpdated = (e: Event) => {
      if ((e as CustomEvent<string>).detail === code) getPayment(code).then(setV).catch(() => {})
    }
    window.addEventListener(BILL_UPDATED_EVENT, onUpdated)
    return () => window.removeEventListener(BILL_UPDATED_EVENT, onUpdated)
  }, [code])
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
  const band = paid ? 'linear-gradient(135deg, #27C796, #12806B)'
    : closed ? 'linear-gradient(135deg, #8A929C, #5E6670)'
    : 'linear-gradient(135deg, #F0B24F, #C9812A)'
  const amountTag = paid ? 'paid' : closed ? STATUS_LABEL[v.status].toLowerCase() : 'due'
  const statusLine = loading ? 'Checking status…'
    : paid && v.completedByMerchant ? '✓ Completed'
    : paid ? (isMine ? '✓ Payment received' : '✓ Paid')
    : v.status === 'processing' && v.payments.some(p => p.status === 'in_ledger') ? 'In Ledger · moving to Arc'
    : closed ? 'Can no longer be paid' // the band already says expired / cancelled / failed
    : STATUS_LABEL[v.status]
  const muted = 'var(--text-secondary)'

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
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, opacity: 0.92, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {paid ? <CheckCircle2 size={13} /> : isBill ? <Receipt size={13} /> : <Clock size={13} />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {isBill ? (v.merchantName || 'Bill') : 'Payment request'} · #{number}
          </span>
        </div>
        <div style={{ position: 'relative', fontSize: 22, fontWeight: 800, letterSpacing: '-0.4px', lineHeight: 1.1, marginTop: 3 }}>
          ${formatAmount(v.amount)} {!paid && <span style={{ fontSize: 13, fontWeight: 700, opacity: 0.85 }}>{amountTag}</span>}
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
          </div>
        )}
        {v.note && <div style={{ fontSize: 12, color: muted, marginTop: isBill ? 5 : 0 }}>{v.note}</div>}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 11.5, color: muted, marginTop: (isBill || v.note) ? 6 : 0 }}>
          <span style={{ fontWeight: 600, color: paid ? 'var(--success)' : muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{statusLine}</span>
          {routeLabel && <span style={{ whiteSpace: 'nowrap' }}>{routeLabel}</span>}
        </div>
        {canPay && (
          <button onClick={pay}
            style={{ width: '100%', marginTop: 8, padding: '9px 0', borderRadius: 10, border: 'none', background: 'var(--text-primary)', color: 'var(--surface)', fontSize: 13, fontWeight: 800, cursor: 'pointer' }}>
            Pay now · ${formatAmount(Math.max(0, v.amount - v.received))}
          </button>
        )}
      </div>
      {open && <BillReceipt v={v} isMine={isMine} isBill={isBill} loading={loading} canPay={canPay}
        onPay={() => { setOpen(false); window.dispatchEvent(new CustomEvent(BILL_PAY_EVENT, { detail: v })) }}
        onClose={() => setOpen(false)} />}
    </div>
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
  const kind = isBill ? 'Bill' : 'Payment Request'
  const number = orderLabel(v)
  const due = Math.max(0, v.amount - v.received)
  const payment = v.payments.find(p => p.txHash) ?? null
  const route = payment?.chain
  const routeLabel = route ? (route === 'Arc_Testnet' ? 'Arc' : `${CHAIN_LABEL[route] ?? route} → Arc`) : null
  const when = (iso: string | null | undefined) => iso
    ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : null
  const status = paid ? 'success' : closed ? 'failed' : 'pending'
  const title = paid ? (isMine ? 'Payment Received' : 'Paid Successfully')
    : closed ? `${kind} ${STATUS_LABEL[v.status]}`
    : kind
  const statusText = loading ? 'Checking status…'
    : paid && v.completedByMerchant ? 'Completed by merchant'
    : v.status === 'processing' && v.payments.some(p => p.status === 'in_ledger') ? 'In Ledger · moving to Arc'
    : STATUS_LABEL[v.status]
  const hash = payment?.txHash || null
  const explorerHref = hash
    ? (route && route !== 'Arc_Testnet' ? null : `https://testnet.arcscan.app/tx/${hash}`)
    : null

  return (
    <ReceiptPopup
      onClose={onClose}
      status={status}
      title={title}
      subtitle={<>
        <span style={{ display: 'block', fontSize: 20, fontWeight: 800, color: paid ? 'var(--success)' : 'var(--text-primary)', marginBottom: 4 }}>
          ${formatAmount(v.amount)} {v.currency || 'USDC'}
        </span>
        Order #{number}{v.merchantName ? ` · ${v.merchantName}` : ''}
      </>}
      rows={[
        { label: 'Status', value: statusText, positive: paid },
        { label: isBill ? 'Total' : 'Amount', value: `$${formatAmount(v.amount)} USDC` },
        ...(v.received > 0 ? [{ label: isMine ? 'Received' : 'Paid', value: `$${formatAmount(v.received)} USDC`, positive: true }] : []),
        ...(!paid && !closed && due > 0 ? [{ label: 'Still due', value: `$${formatAmount(due)} USDC` }] : []),
        ...(hash ? [{ label: 'Transaction Hash', value: `${hash.slice(0, 6)}…${hash.slice(-4)}` }] : []),
        ...(when(v.paidAt ?? payment?.createdAt) ? [{ label: paid ? 'Paid on' : 'Time', value: when(v.paidAt ?? payment?.createdAt)! }] : []),
      ]}
      detailRows={[
        { label: 'Order', value: `#${number}` },
        ...(v.merchantName || v.merchantUsername ? [{ label: 'Merchant', value: v.merchantName || `${v.merchantUsername}.arc` }] : []),
        ...(v.customerUsername ? [{ label: 'Customer', value: `${v.customerUsername.replace(/\.arc$/i, '')}.arc` }] : []),
        ...(isBill && v.items?.length
          ? v.items.map(i => ({
              label: `${i.name} × ${Number(i.qty)}`,
              value: Number.isFinite(Number(i.total ?? i.qty * i.price)) ? `$${formatAmount(Number(i.total ?? i.qty * i.price))}` : '—',
            }))
          : []),
        ...(v.note ? [{ label: 'Note', value: v.note }] : []),
        ...(routeLabel ? [{ label: 'Route', value: routeLabel }] : []),
        ...(when(v.createdAt) ? [{ label: 'Created', value: when(v.createdAt)! }] : []),
        ...(!paid && !closed && when(v.expiresAt) ? [{ label: 'Expires', value: when(v.expiresAt)! }] : []),
        ...(v.completedByMerchant && v.completedNote ? [{ label: 'Merchant note', value: v.completedNote }] : []),
      ]}
      detailsTitle={`${kind} details`}
      // Only a settled (paid) bill is history; an open or closed one isn't.
      stamp={paid ? 'History' : undefined}
      fullHash={hash || undefined}
      links={hash && explorerHref ? [{ title: 'View on ArcScan', explorer: 'ArcScan', hash, href: explorerHref }] : undefined}
      primaryLabel={canPay ? `${isBill ? 'Pay invoice' : 'Pay'} · $${formatAmount(due)}` : 'Done'}
      onPrimary={canPay ? onPay : onClose}
    />
  )
}
