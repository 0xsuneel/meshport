// Receive → My requests: every payment request you made (Receive → Request
// payment, or chat + → Request) - and for merchants their bills too -
// newest first, with its live status. Tap one
// to reopen it: a waiting one shows its QR / Share / Cancel again, a paid one
// shows who paid, how much, when and the transaction.
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Plus } from 'lucide-react'
import { HistoryRow, HistoryIcon } from '@/components/ui/HistoryRow'
import { useReturnFlash } from '@/hooks/useReturnFlash'
import { useAuthStore } from '@/store'
import { formatAmount } from '@/lib/utils'
import { listMyIntents, subscribeMerchantPayments, orderLabel, orderKindOf, orderTitle, expiryText, STATUS_LABEL, type MerchantIntent } from '@/lib/merchantPay'
import { RequestQrPanel } from './RequestQrPanel'
import { useMerchant } from '@/lib/merchant'

type Filter = 'all' | 'waiting' | 'paid' | 'closed'
type Bucket = 'waiting' | 'paid' | 'closed'

/** The status as it stands now: a pending request past its expiry is expired. */
export function requestStatus(i: Pick<MerchantIntent, 'status' | 'expiresAt'>): MerchantIntent['status'] {
  return i.status === 'pending' && i.expiresAt && new Date(i.expiresAt).getTime() < Date.now() ? 'expired' : i.status
}
export function requestBucket(i: Pick<MerchantIntent, 'status' | 'expiresAt'>): Bucket {
  const st = requestStatus(i)
  return st === 'paid' ? 'paid' : ['expired', 'cancelled', 'failed'].includes(st) ? 'closed' : 'waiting'
}

/** "Today, 5:20 PM" / "Yesterday, 9:15 AM" / "09 Oct, 2:10 PM". */
function when(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(new Date()) - day(d)) / 864e5)
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const date = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
  return `${date}, ${time}`
}

function statusLine(i: MerchantIntent): { text: string; color: string } {
  const st = requestStatus(i)
  const who = i.customerUsername ? `${i.customerUsername.replace(/\.arc$/i, '')}.arc` : null
  if (st === 'paid') {
    return { text: `${who ? `Paid by ${who}` : 'Paid'}${i.paidAt ? ` · ${when(i.paidAt)}` : ''}`, color: 'var(--success)' }
  }
  if (st === 'partially_paid') return { text: `Partially paid · $${formatAmount(i.received)} of $${formatAmount(i.amount)}`, color: 'var(--brand-text)' }
  if (st === 'expired') return { text: `Expired${i.expiresAt ? ` · ${when(i.expiresAt)}` : ''}`, color: 'var(--text-secondary)' }
  if (st === 'cancelled' || st === 'failed') return { text: STATUS_LABEL[st], color: 'var(--text-secondary)' }
  if (st === 'pending') {
    const exp = expiryText(i.expiresAt)
    return { text: `Waiting for payment · ${exp ? exp.replace(/^Expires/, 'expires') : 'no expiry'}`, color: 'var(--warning)' }
  }
  return { text: STATUS_LABEL[st], color: 'var(--warning)' }
}

export function MyRequestsPage() {
  const navigate = useNavigate()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const isMerchant = useMerchant().isMerchant
  const [items, setItems] = useState<MerchantIntent[] | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState<MerchantIntent | null>(null)
  const listFlash = useReturnFlash()
  const closeOpen = () => { if (open) listFlash.closed(open.id); setOpen(null) }

  const load = useCallback(async () => {
    try {
      // Requests and (merchants) bills - every order you sent.
      setItems(await listMyIntents(200))
    } catch { setItems(prev => prev ?? []) }
  }, [])

  // Live: a payment or status change on any of my requests reloads the list.
  useEffect(() => {
    void load()
    const unsub = walletAddress ? subscribeMerchantPayments(walletAddress, () => { void load() }) : () => {}
    const iv = setInterval(() => { void load() }, 30_000)
    return () => { unsub(); clearInterval(iv) }
  }, [walletAddress, load])

  const counts = { waiting: 0, paid: 0, closed: 0 }
  for (const i of items ?? []) counts[requestBucket(i)] += 1
  const shown = (items ?? []).filter(i => filter === 'all' || requestBucket(i) === filter)

  const newRequest = () => navigate('/receive?request=1')

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)', paddingBottom: 90 }}>
      <div className="header-row sticky top-0 z-20 backdrop-blur-md bg-bg/95 gap-3 px-5 pt-header pb-header">
        <button onClick={() => (open ? closeOpen() : navigate('/receive'))} className="back-btn" aria-label="Back">
          <ArrowLeft className="w-5 h-5 text-text-primary" />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="text-xl font-bold text-text-primary">My requests</h1>
          <p className="text-text-secondary text-xs mt-0.5">{isMerchant ? 'Requests and bills you sent, and whether they\'re paid' : 'Payment requests you made, and whether they\'re paid'}</p>
        </div>
      </div>

      <div style={{ padding: '0 16px', maxWidth: 560, margin: '0 auto' }}>
        {open ? (
          // The same screen as a new request (and Business's): QR, live status, link.
          <div className="flex flex-col rounded-3xl bg-surface border border-border overflow-hidden" style={{ paddingTop: 12 }}>
            <RequestQrPanel key={open.code} initialOrder={open} onClose={() => { closeOpen(); void load() }} onNewRequest={newRequest} />
          </div>
        ) : (
          <>
            <div role="tablist" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {([['all', 'All'], ['waiting', 'Waiting'], ['paid', 'Paid'], ['closed', 'Closed']] as [Filter, string][]).map(([id, label]) => {
                const on = filter === id
                const n = id === 'all' ? 0 : counts[id]
                return (
                  <button key={id} role="tab" aria-selected={on} onClick={() => setFilter(id)}
                    style={{ padding: '6px 13px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
                      background: on ? 'color-mix(in srgb, var(--brand) 22%, transparent)' : 'color-mix(in srgb, var(--text-primary) 5%, transparent)',
                      color: on ? 'var(--brand-text)' : 'var(--text-secondary)' }}>
                    {label}{id === 'waiting' && n > 0 ? ` ${n}` : ''}
                  </button>
                )
              })}
            </div>

            {items === null ? (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16 }}>
                {[0, 1, 2].map(k => (
                  <div key={k} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '13px 14px', borderTop: k ? '1px solid var(--border)' : 'none' }}>
                    <div className="animate-pulse" style={{ width: 38, height: 38, borderRadius: '50%', background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)' }} />
                    <div style={{ flex: 1 }}>
                      <div className="animate-pulse" style={{ width: 130, height: 12, borderRadius: 6, background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)' }} />
                      <div className="animate-pulse" style={{ width: 90, height: 10, borderRadius: 6, marginTop: 7, background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)' }} />
                    </div>
                  </div>
                ))}
              </div>
            ) : shown.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '36px 12px', color: 'var(--text-secondary)', fontSize: 14 }}>
                <p style={{ margin: '0 0 14px' }}>{filter === 'all' ? "You haven't requested a payment yet." : `No ${filter} requests.`}</p>
                <button onClick={newRequest} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '11px 18px', borderRadius: 14, border: 'none', cursor: 'pointer', background: 'var(--brand)', color: '#fff', fontSize: 14, fontWeight: 700 }}>
                  <Plus size={16} /> Request payment
                </button>
              </div>
            ) : (
              <div>
                {shown.map(i => {
                  const bucket = requestBucket(i)
                  const st = requestStatus(i)
                  const line = statusLine(i)
                  const who = i.customerUsername && bucket === 'waiting' ? ` · ${i.customerUsername.replace(/\.arc$/i, '')}.arc` : ''
                  return (
                    <HistoryRow key={i.id} flash={i.id === listFlash.flashId}
                      onClick={() => { listFlash.opened(); setOpen(i) }}
                      icon={<HistoryIcon tone={bucket === 'paid' ? 'in' : bucket === 'closed' ? 'muted' : st === 'partially_paid' ? 'out' : 'pending'} icon="receive" />}
                      title={`${orderTitle(orderKindOf(i), orderLabel(i), { short: true })}${who}`}
                      meta={<span style={{ color: line.color }}>{line.text}</span>}
                      right={<div style={{ fontSize: 14, fontWeight: 700, color: bucket === 'paid' ? 'var(--success)' : bucket === 'closed' ? 'var(--text-secondary)' : 'var(--text-primary)' }}>
                        {bucket === 'paid' ? '+' : ''}${formatAmount(bucket === 'paid' ? (i.received || i.amount) : i.amount)}
                      </div>} />
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
