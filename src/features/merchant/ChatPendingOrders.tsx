// Chat → pending bills / payment requests between the two people, pinned
// under the conversation header on BOTH sides:
//   • customer: each open order with a Pay button (opens the in-chat pay
//     sheet with the order's amount and number, same as the card's Pay)
//   • merchant: each open order waiting for payment
// Tapping an order scrolls to its card in the chat when it's loaded.
// Hidden when there's nothing open. Paid / cancelled / expired orders drop
// off on their own.
import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Receipt } from 'lucide-react'
import { useAuthStore, useUIStore } from '@/store'
import { formatAmount } from '@/lib/utils'
import {
  listChatPendingOrders, getPayment, paidLocally, subscribeMerchantPayments, orderLabel, orderKindOf, orderTitle, BILL_PAY_EVENT, BILL_UPDATED_EVENT, type ChatPendingOrder,
} from '@/lib/merchantPay'

// Last known open orders per chat partner. The strip sits above the
// messages, so it must be there from the chat's first frame: appearing a
// moment later pushed every message down and back (the "dancing" open).
// The chat list prefetches this with each chat's messages.
const _pendingCache = new Map<string, ChatPendingOrder[]>()
const _pendingInFlight = new Map<string, Promise<ChatPendingOrder[]>>()
const sameOrders = (a: ChatPendingOrder[], b: ChatPendingOrder[]) =>
  a.length === b.length && a.every((o, i) => o.code === b[i].code && o.amount === b[i].amount && o.received === b[i].received && o.note === b[i].note)

function fetchPending(otherUserId: string): Promise<ChatPendingOrder[]> {
  let p = _pendingInFlight.get(otherUserId)
  if (!p) {
    p = listChatPendingOrders(otherUserId)
      .then(list => { _pendingCache.set(otherUserId, list); return list })
      .finally(() => _pendingInFlight.delete(otherUserId))
    _pendingInFlight.set(otherUserId, p)
  }
  return p
}

/** Load a chat's open orders ahead of opening it (once per chat unless asked again). */
export function prefetchPendingOrders(otherUserId: string | null | undefined, force = false): Promise<unknown> {
  if (!otherUserId || (!force && _pendingCache.has(otherUserId))) return Promise.resolve()
  return fetchPending(otherUserId).catch(() => {})
}

export function ChatPendingOrders({ otherUserId, refreshKey }: { otherUserId: string | null | undefined; refreshKey?: unknown }) {
  const { showToastMessage } = useUIStore()
  const [orders, setOrders] = useState<ChatPendingOrder[]>(() => (otherUserId && _pendingCache.get(otherUserId)) || [])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!otherUserId) { setOrders([]); return }
    try {
      const list = await fetchPending(otherUserId)
      // Same orders: keep the same state, so nothing re-renders or moves.
      setOrders(prev => sameOrders(prev, list) ? prev : list)
    } catch { /* keep last */ }
  }, [otherUserId])
  // Another chat (the page is reused when switching): its own cached list at once.
  useEffect(() => { setOrders((otherUserId && _pendingCache.get(otherUserId)) || []) }, [otherUserId])

  useEffect(() => { void load() }, [load, refreshKey])
  // Re-read after a payment: at once, then again as the server confirms it.
  const [, bump] = useState(0)
  useEffect(() => {
    const t = setInterval(() => { void load() }, 30_000)
    const onUpdated = () => { bump(n => n + 1); void load(); setTimeout(() => { void load() }, 2500); setTimeout(() => { void load() }, 6000) }
    window.addEventListener(BILL_UPDATED_EVENT, onUpdated)
    return () => { clearInterval(t); window.removeEventListener(BILL_UPDATED_EVENT, onUpdated) }
  }, [load])
  // The business's side: its orders change live (a customer's payment is
  // confirmed) - refresh this strip and the chat's cards right away instead
  // of waiting for the next check. Nothing arrives for a personal account.
  const myWallet = useAuthStore(s => s.walletAddress)
  useEffect(() => {
    if (!myWallet || !otherUserId) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const stop = subscribeMerchantPayments(myWallet, () => {
      if (timer) return
      timer = setTimeout(() => { timer = null; window.dispatchEvent(new CustomEvent(BILL_UPDATED_EVENT)) }, 300)
    })
    return () => { if (timer) clearTimeout(timer); stop() }
  }, [myWallet, otherUserId])

  // An order this app just paid leaves the strip at once (see notePaidLocally).
  const shownOrders = orders.filter(o => !paidLocally(o.code) && o.received + 1e-6 < o.amount)
  if (shownOrders.length === 0) return null

  const due = (o: ChatPendingOrder) => Math.max(0, Math.round((o.amount - o.received) * 1e6) / 1e6)
  const totalDue = shownOrders.reduce((s, o) => s + due(o), 0)
  const iAmMerchant = shownOrders.every(o => o.iAmMerchant)
  const label = (o: ChatPendingOrder) => orderLabel({ code: o.code, orderNumber: o.orderNumber })

  const scrollTo = (o: ChatPendingOrder) => {
    const el = document.getElementById(`order-${label(o).toLowerCase()}`) ?? document.getElementById(`bill-${o.code.slice(0, 6)}`)
    if (!el) return false
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return true
  }

  const pay = async (o: ChatPendingOrder) => {
    setBusy(o.code)
    try {
      const v = await getPayment(o.code)
      window.dispatchEvent(new CustomEvent(BILL_PAY_EVENT, { detail: v }))
      setOpen(false)
    } catch (e) {
      showToastMessage(e instanceof Error ? e.message : 'Could not open the payment', 'error')
    }
    setBusy(null)
  }

  return (
    <div className="px-3 pt-2 relative z-10">
      <div style={{ borderRadius: 14, border: '1px solid color-mix(in srgb, var(--warning) 35%, var(--border))',
        background: 'color-mix(in srgb, var(--surface) 92%, var(--warning) 8%)', backdropFilter: 'blur(8px)', overflow: 'hidden' }}>
        <button onClick={() => setOpen(v => !v)} className="w-full flex items-center gap-2 text-left"
          style={{ padding: '9px 12px', background: 'transparent', border: 'none', cursor: 'pointer' }}>
          <Receipt size={16} color="var(--warning)" style={{ flexShrink: 0 }} />
          <span className="flex-1 min-w-0 truncate" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
            {shownOrders.length} pending {shownOrders.length === 1 ? (shownOrders[0].kind === 'invoice' ? 'bill' : 'request') : 'bills'}
            <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
              {' · '}${formatAmount(totalDue)} USDC {iAmMerchant ? 'to receive' : 'due'}
            </span>
          </span>
          {open ? <ChevronUp size={16} color="var(--text-secondary)" /> : <ChevronDown size={16} color="var(--text-secondary)" />}
        </button>
        {open && (
          <div style={{ borderTop: '1px solid var(--border)', maxHeight: 220, overflowY: 'auto' }}>
            {shownOrders.map(o => (
              <div key={o.code} className="flex items-center gap-2" style={{ padding: '9px 12px', borderBottom: '1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)' }}>
                <button onClick={() => { if (!scrollTo(o) && !o.iAmMerchant) void pay(o) }} className="flex-1 min-w-0 text-left"
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}>
                  <div className="truncate" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {orderTitle(orderKindOf(o), label(o))}
                  </div>
                  <div className="truncate" style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 1 }}>
                    ${formatAmount(due(o))} USDC {o.received > 0 ? `left of $${formatAmount(o.amount)}` : ''}
                    {!o.iAmMerchant && o.merchantName ? ` · ${o.merchantName}` : ''}{o.note ? ` · ${o.note}` : ''}
                  </div>
                </button>
                {o.iAmMerchant ? (
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--warning-text)', flexShrink: 0 }}>
                    {o.received > 0 ? 'Partly paid' : 'Waiting'}
                  </span>
                ) : (
                  <button onClick={() => void pay(o)} disabled={busy === o.code}
                    style={{ flexShrink: 0, padding: '6px 14px', borderRadius: 10, border: 'none', cursor: 'pointer',
                      background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 700, opacity: busy === o.code ? 0.6 : 1 }}>
                    Pay
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
