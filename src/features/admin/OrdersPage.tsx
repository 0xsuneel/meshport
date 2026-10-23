// Admin → Orders. Every account's payment requests and bills (read-only),
// for support. This is the only place an admin sees other people's orders:
// the admin's own app (Receive → My requests, Manage money) lists just their own.
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { ReceiptText, X, ExternalLink } from 'lucide-react'
import { AdminCard } from '@/components/admin/AdminCard'
import { formatAmount } from '@/lib/utils'
import { explorerTxUrl } from '@/lib/chainExplorers'
import {
  adminListOrders, adminListOrderPayments, orderKindOf, orderTitle, STATUS_LABEL,
  type AdminOrder, type MerchantPayment,
} from '@/lib/merchantPay'
import { requestStatus, requestBucket } from '@/features/receive/MyRequestsPage'

type KindTab = 'all' | 'request' | 'bill'
type StatusTab = 'all' | 'waiting' | 'paid' | 'closed'

const KIND_TABS: Array<{ key: KindTab; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'request', label: 'Requests' },
  { key: 'bill', label: 'Bills' },
]
const STATUS_TABS: Array<{ key: StatusTab; label: string }> = [
  { key: 'all', label: 'Any status' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'paid', label: 'Paid' },
  { key: 'closed', label: 'Closed' },
]

const BUCKET_COLOR = { waiting: 'var(--warning)', paid: 'var(--success)', closed: 'var(--text-secondary)' } as const

const handle = (u: string | null) => (u ? `${u.replace(/\.arc$/i, '')}.arc` : null)
const shortAddr = (a: string | null | undefined) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : null)
const isBill = (o: AdminOrder) => orderKindOf(o) === 'bill'

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      style={{
        padding: '6px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
        background: active ? 'var(--brand)' : 'var(--surface)',
        color: active ? '#fff' : 'var(--text-secondary)', border: '1px solid var(--border)',
      }}>
      {children}
    </button>
  )
}

export function OrdersPage() {
  const [orders, setOrders] = useState<AdminOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<KindTab>('all')
  const [status, setStatus] = useState<StatusTab>('all')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<AdminOrder | null>(null)
  const [payments, setPayments] = useState<MerchantPayment[] | null>(null)

  useEffect(() => {
    adminListOrders()
      .then(o => { setOrders(o); setError(null) })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!active) return
    setPayments(null)
    adminListOrderPayments(active.id).then(setPayments).catch(() => setPayments([]))
  }, [active])

  const ofKind = (o: AdminOrder, k: KindTab) => k === 'all' || (k === 'bill') === isBill(o)
  const q = query.trim().toLowerCase().replace(/^@/, '')
  const matches = (o: AdminOrder) => !q || [
    o.orderNumber, orderTitle(orderKindOf(o), o.orderNumber), o.code, o.merchantUsername, o.merchantName,
    o.merchantWallet, o.customerUsername, o.customerWallet,
  ].some(v => v && String(v).toLowerCase().includes(q))

  const shown = useMemo(
    () => orders.filter(o => ofKind(o, kind) && (status === 'all' || requestBucket(o) === status) && matches(o)),
    [orders, kind, status, q],
  )
  const kindCount = (k: KindTab) => orders.filter(o => ofKind(o, k)).length

  if (loading) return <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading orders…</p>

  const row = (label: string, value: string | null | undefined) => value ? (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: 13 }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
    </div>
  ) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {error && <AdminCard><p style={{ margin: 0, fontSize: 13, color: 'var(--danger)' }}>{error}</p></AdminCard>}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {KIND_TABS.map(t => <Chip key={t.key} active={kind === t.key} onClick={() => setKind(t.key)}>{t.label} ({kindCount(t.key)})</Chip>)}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {STATUS_TABS.map(t => <Chip key={t.key} active={status === t.key} onClick={() => setStatus(t.key)}>{t.label}</Chip>)}
      </div>
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search order number, username or wallet"
        style={{ width: '100%', boxSizing: 'border-box', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '10px 14px', fontSize: 13, color: 'var(--text-primary)', outline: 'none' }} />

      {shown.length === 0 ? (
        <AdminCard>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 0', gap: 8 }}>
            <ReceiptText size={28} color="var(--text-secondary)" />
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0 }}>No orders here</p>
          </div>
        </AdminCard>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {shown.map(o => {
            const bucket = requestBucket(o)
            const from = handle(o.merchantUsername) || o.merchantName || shortAddr(o.merchantWallet)
            const to = handle(o.customerUsername) || shortAddr(o.customerWallet)
            return (
              <AdminCard key={o.id} padding={14} onClick={() => setActive(o)}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{orderTitle(orderKindOf(o), o.orderNumber || o.code)}</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>${formatAmount(o.amount)}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 6 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {from}{to ? ` → ${to}` : ''} · {new Date(o.createdAt).toLocaleString()}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: BUCKET_COLOR[bucket], whiteSpace: 'nowrap' }}>{STATUS_LABEL[requestStatus(o)]}</span>
                </div>
              </AdminCard>
            )
          })}
        </div>
      )}

      <AnimatePresence>
      {active && (
        <DesktopDialogFrame key="order" onClose={() => setActive(null)} maxWidth={520}>
          <div style={{ padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <div>
                <p style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>{orderTitle(orderKindOf(active), active.orderNumber || active.code)}</p>
                <p style={{ fontSize: 12, color: BUCKET_COLOR[requestBucket(active)], margin: '4px 0 0', fontWeight: 600 }}>{STATUS_LABEL[requestStatus(active)]}</p>
              </div>
              <button onClick={() => setActive(null)} style={{ background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', border: 'none', borderRadius: '50%', width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                <X size={14} color="var(--text-secondary)" />
              </button>
            </div>

            <div style={{ marginBottom: 14 }}>
              {row('Amount', `$${formatAmount(active.amount)} USDC`)}
              {row('Received', active.received > 0 ? `$${formatAmount(active.received)} USDC` : null)}
              {row(isBill(active) ? 'Business' : 'Requested by', handle(active.merchantUsername) || active.merchantName)}
              {row('Business wallet', active.merchantWallet)}
              {row(isBill(active) ? 'Customer' : 'Requested from', handle(active.customerUsername))}
              {row('Customer wallet', active.customerWallet)}
              {row('Link code', active.code)}
              {row('Note', active.note)}
              {row('Created', new Date(active.createdAt).toLocaleString())}
              {row('Expires', active.expiresAt ? new Date(active.expiresAt).toLocaleString() : null)}
              {row('Paid', active.paidAt ? new Date(active.paidAt).toLocaleString() : null)}
              {row('Completed by business', active.completedByMerchant ? (active.completedNote || 'Yes') : null)}
            </div>

            {active.items?.length ? (
              <div style={{ background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', borderRadius: 16, padding: 14, marginBottom: 14 }}>
                {active.items.map((i, n) => (
                  <div key={n} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-primary)', padding: '3px 0' }}>
                    <span>{i.qty}× {i.name}</span>
                    <span>${formatAmount(i.qty * i.price)}</span>
                  </div>
                ))}
              </div>
            ) : null}

            <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', margin: '0 0 8px' }}>Payments</p>
            {payments === null ? (
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>Loading…</p>
            ) : payments.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>No payments recorded</p>
            ) : payments.map(p => {
              const url = explorerTxUrl(p.chain, p.txHash)
              return (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: 12 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {handle(p.customerUsername) || shortAddr(p.from)} · {p.chain} · {new Date(p.createdAt).toLocaleString()}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-primary)', fontWeight: 600 }}>
                    ${formatAmount(p.amount)}
                    {url && <a href={url} target="_blank" rel="noreferrer" style={{ color: 'var(--brand-text)', display: 'flex' }}><ExternalLink size={13} /></a>}
                  </span>
                </div>
              )
            })}
          </div>
        </DesktopDialogFrame>
      )}
      </AnimatePresence>
    </div>
  )
}
