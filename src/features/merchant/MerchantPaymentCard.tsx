// Payment request / bill card shown inside a chat message that contains a
// /pay/r/<code> link. Chat stays messaging; the card reads the live status
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
import { formatAmount } from '@/lib/utils'
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
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean).filter(l => !/\/pay\/r\//i.test(l))
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

export function MerchantPaymentCard({ code, isMine, text }: { code: string; isMine: boolean; text?: string }) {
  const [live, setV] = useState<PaymentView | null>(null)
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
  const fg = isMine ? '#fff' : 'var(--text-primary)'
  const muted = isMine ? 'rgba(255,255,255,0.75)' : 'var(--text-secondary)'
  const ok = isMine ? '#fff' : 'var(--success)'
  const canPay = !loading && !paid && !closed && !isMine && v.status !== 'processing'
  const pay = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (canPay) window.dispatchEvent(new CustomEvent(BILL_PAY_EVENT, { detail: v }))
  }

  return (
    <div id={`order-${number.toLowerCase()}`} onClick={e => e.stopPropagation()}
      style={{
        minWidth: 220, maxWidth: 280, marginBottom: 6, padding: '10px 12px', borderRadius: 12,
        background: isMine ? 'rgba(255,255,255,0.15)' : 'color-mix(in srgb, var(--text-primary) 8%, transparent)',
        opacity: closed ? 0.6 : 1,
      }}>
      {/* Anchor for payment replies sent before order numbers existed. */}
      <span id={`bill-${code.slice(0, 6)}`} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {paid ? <CheckCircle2 size={16} color={ok} /> : isBill ? <Receipt size={15} color={fg} /> : <Clock size={16} color={isMine ? '#fff' : 'var(--warning)'} />}
        <span style={{ fontSize: 12, fontWeight: 700, color: muted, textTransform: 'uppercase', letterSpacing: '0.05em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {isBill ? `Bill${v.merchantName ? ` · ${v.merchantName}` : ''}` : 'Payment request'}
        </span>
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: fg, marginTop: 3 }}>Order #{number}</div>

      {isBill && (
        <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr auto', gap: '3px 10px', fontSize: 12, color: fg }}>
          {v.items!.slice(0, 8).map((i, k) => (
            <div key={k} style={{ display: 'contents' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.name} <span style={{ color: muted }}>× {Number(i.qty)}</span></span>
              <span style={{ textAlign: 'right', fontWeight: 600 }}>{Number.isFinite(Number(i.total ?? i.qty * i.price)) ? `$${formatAmount(Number(i.total ?? i.qty * i.price))}` : ''}</span>
            </div>
          ))}
          {v.items!.length > 8 && <span style={{ color: muted }}>+{v.items!.length - 8} more</span>}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 8, borderTop: isBill ? `1px solid ${isMine ? 'rgba(255,255,255,0.25)' : 'var(--border)'}` : 'none', paddingTop: isBill ? 6 : 0 }}>
        <span style={{ fontSize: 12, color: muted }}>{isBill ? 'Total' : ''}</span>
        <span style={{ fontSize: 16, fontWeight: 800, color: fg }}>${formatAmount(v.amount)} USDC</span>
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: paid ? ok : muted, marginTop: 3 }}>
        {loading ? 'Checking status…'
          : paid && v.completedByMerchant ? '✓ Completed'
          : paid ? (isMine ? '✓ Payment received' : '✓ Paid')
          : v.status === 'processing' && v.payments.some(p => p.status === 'in_ledger') ? 'In Ledger · moving to Arc'
          : STATUS_LABEL[v.status]}{routeLabel ? ` · ${routeLabel}` : ''}
      </div>
      {v.note && <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>{v.note}</div>}

      {canPay && (
        <button onClick={pay}
          style={{ width: '100%', marginTop: 8, padding: '9px 0', borderRadius: 10, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
          {isBill ? 'Pay invoice' : 'Pay'} · ${formatAmount(Math.max(0, v.amount - v.received))}
        </button>
      )}
    </div>
  )
}
