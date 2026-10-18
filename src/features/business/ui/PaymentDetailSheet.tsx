/**
 * PaymentDetailSheet — bottom sheet with payment detail, timeline, and actions.
 * Supports received, to_settle, and refunded statuses.
 */
import React from 'react'
import { ExternalLink, ArrowDownToLine, RotateCcw, FileText, MessageCircle, Copy, ShieldAlert } from 'lucide-react'
import type { Payment } from './types'
import { formatTime } from './types'
import { Sheet } from './primitives'

export interface RefundInfo {
  id: string
  amount: string
  reason: string
  when: string    // ISO
  /** Chain the refund went out on (e.g. "Arc", "Base") */
  chainLabel?: string
  txUrl?: string
}

export interface PaymentDetailSheetProps {
  payment: Payment | null
  explorerUrl?: string
  onClose: () => void
  onSettle: (p: Payment) => void
  onRefund?: () => void
  onReceipt?: () => void
  /** Why there's no Refund (e.g. paid from a contract or exchange); shown instead. */
  refundNote?: string
  /** Every refund of this payment, oldest first (a payment can be refunded several times) */
  refunds?: RefundInfo[]
  /** Refunded so far and what can still go back (pre-formatted) */
  refundTotals?: { refunded: string; left: string }
  /** This customer's history with the business, for the customer card */
  customer?: { payments: number; total: string }
  /** Opens a chat with the customer (MeshPort users only) */
  onChat?: () => void
  /** Store the payment belongs to */
  store?: string
  /** Payer's full wallet when they have no MeshPort account (Copy address) */
  wallet?: string
  onCopyWallet?: () => void
}

// Customer card + round actions (designs 4 and 3): who paid and how often,
// the amount with its two steps, then Receipt / Explorer / Refund as the
// app's round buttons, and the details as small tiles.

const initial = (name: string) => (/^0x/i.test(name) ? '0x' : (name.replace(/\.arc$/, '')[0] ?? '?').toUpperCase())

function Tile({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-[14px] bg-bg border border-border px-3.5 py-3 flex flex-col gap-0.5 min-w-0">
      <span className="text-xs text-text-muted">{label}</span>
      <span className={`text-sm font-semibold text-text-primary truncate ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  )
}

function RoundAction({ label, onClick, href, tone = 'brand', children }: {
  label: string; onClick?: () => void; href?: string; tone?: 'brand' | 'danger'; children: React.ReactNode
}) {
  const circle = (
    <span className={`flex items-center justify-center rounded-full text-white ${tone === 'danger' ? 'bg-danger' : 'bg-brand'}`} style={{ width: 55, height: 55 }}>
      {children}
    </span>
  )
  const cls = 'flex flex-col items-center gap-2 active:scale-[0.95] transition-transform'
  return href
    ? <a href={href} target="_blank" rel="noreferrer" className={cls}>{circle}<span className="text-xs font-medium text-text-primary leading-none">{label}</span></a>
    : <button type="button" onClick={onClick} className={cls}>{circle}<span className="text-xs font-medium text-text-primary leading-none">{label}</span></button>
}

export function PaymentDetailSheet({
  payment, explorerUrl, onClose, onSettle, onRefund, onReceipt, refundNote, refunds = [], refundTotals, customer, onChat, store, wallet, onCopyWallet,
}: PaymentDetailSheetProps) {
  const isRefunded = payment?.status === 'refunded'
  // Paid through a bridge: there's no paying wallet on that chain.
  const bridge = !!payment && /^0x0{4}…0{4}$/i.test(payment.from)
  const payerName = bridge ? 'Bridge payment' : payment?.from ?? ''
  const toSettle = payment?.status === 'to_settle'
  const steps = payment ? [
    { label: `Paid on ${payment.chainLabel}`, done: true },
    isRefunded ? { label: 'Refunded', done: true, danger: true }
      : { label: toSettle ? 'Waiting to settle' : 'In Arc balance', done: !toSettle },
  ] : []

  return (
    <Sheet open={!!payment} onClose={onClose}>
      {payment && (
        <div className="flex flex-col gap-5 px-5 pb-6 pt-2 overflow-y-auto max-h-[88dvh]">

          {/* Customer */}
          <div className="flex items-center gap-3 rounded-2xl bg-bg border border-border p-3.5">
            <span className="shrink-0 rounded-full p-[2px] bg-brand" style={{ width: 48, height: 48 }}>
              <span className="flex items-center justify-center w-full h-full rounded-full bg-brand text-white font-bold" style={{ border: '2px solid var(--bg)' }}>
                {bridge ? '⇄' : initial(payment.from)}
              </span>
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[15px] font-bold text-text-primary truncate">{payerName}</span>
              <span className="block text-xs text-text-muted truncate">
                {bridge ? 'Sent through a bridge · no wallet to refund'
                  : `${onChat ? '' : 'Not on MeshPort · '}${customer && customer.payments > 1 ? `${customer.payments} payments · ${customer.total} total` : 'First payment'}`}
              </span>
            </span>
            {onChat && (
              <button type="button" onClick={onChat}
                className="shrink-0 inline-flex items-center gap-1.5 min-h-[36px] px-3 rounded-full border border-border text-[13px] font-semibold text-text-primary active:bg-border/30">
                <MessageCircle className="size-4" /> Chat
              </button>
            )}
            {!onChat && !bridge && wallet && onCopyWallet && (
              <button type="button" onClick={onCopyWallet}
                className="shrink-0 inline-flex items-center gap-1.5 min-h-[36px] px-3 rounded-full border border-border text-[13px] font-semibold text-text-primary active:bg-border/30">
                <Copy className="size-4" /> Copy
              </button>
            )}
          </div>

          {/* Amount + status */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13px] text-text-muted">{[payment.order, formatTime(payment.time)].filter(Boolean).join(' · ')}</p>
              <p className={`text-4xl font-bold tabular-nums tracking-tight mt-1 ${isRefunded ? 'text-text-muted line-through' : 'text-text-primary'}`}>{payment.amount}</p>
            </div>
            <span className={`shrink-0 text-xs font-semibold rounded-full px-3 py-1.5 ${
              isRefunded ? 'bg-danger/10 text-danger' : toSettle ? 'bg-warning/10 text-warning' : 'bg-brand/10 text-brand-text'}`}>
              {isRefunded ? 'Refunded' : toSettle ? 'To settle' : 'Paid'}
            </span>
          </div>

          {/* Screening: sender on USDC's blocklist */}
          {payment.blocked && (
            <div role="alert" className="flex gap-3 rounded-2xl bg-danger/10 border border-danger/20 px-4 py-3.5">
              <ShieldAlert className="size-5 text-danger shrink-0 mt-0.5" />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-danger">Blocked sender</span>
                <span className="block text-xs text-text-secondary leading-relaxed mt-0.5">This address is on USDC's blocklist. Don't ship goods; contact support.</span>
              </span>
            </div>
          )}
          {!payment.blocked && payment.late && (
            <p className="-mt-2 text-xs font-semibold text-warning">Paid late · arrived after it expired</p>
          )}

          {/* Two steps */}
          <div className="flex gap-2">
            {steps.map(st => (
              <div key={st.label} className="flex-1 flex flex-col gap-1.5">
                <span className={`h-1 rounded-full ${st.done ? ('danger' in st && st.danger ? 'bg-danger' : 'bg-brand') : 'bg-border'}`} />
                <span className={`text-xs ${st.done ? 'text-text-secondary' : 'text-text-muted'}`}>{st.label}</span>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div className="flex justify-around py-1">
            {toSettle && (
              <RoundAction label="Settle" onClick={() => onSettle(payment)}><ArrowDownToLine className="size-6" /></RoundAction>
            )}
            {onReceipt && <RoundAction label="Receipt" onClick={onReceipt}><FileText className="size-6" /></RoundAction>}
            {explorerUrl && <RoundAction label="Explorer" href={explorerUrl}><ExternalLink className="size-6" /></RoundAction>}
            {!isRefunded && onRefund && (
              <RoundAction label="Refund" tone="danger" onClick={onRefund}><RotateCcw className="size-6" /></RoundAction>
            )}
          </div>
          {!isRefunded && !onRefund && refundNote && (
            <p className="-mt-2 text-center text-xs text-text-muted leading-relaxed">{refundNote}</p>
          )}

          {/* Details */}
          <div className="grid grid-cols-2 gap-2.5">
            <Tile label="Network" value={payment.chainLabel} />
            {store ? <Tile label="Store" value={store} /> : <Tile label="Amount" value={payment.amount} />}
            <Tile label="Date" value={new Date(payment.time).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })} />
            <Tile label="Time" value={new Date(payment.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} />
          </div>

          {/* Refunds (one or more) */}
          {refunds.length > 0 && (
            <div className="rounded-2xl bg-danger/10 border border-danger/20 px-4 py-3.5 flex flex-col gap-2">
              <p className="text-xs font-semibold text-danger uppercase tracking-wider">
                {isRefunded ? `Refunded ${refundTotals?.refunded ?? ''}` : `Partly refunded · ${refundTotals?.refunded ?? ''} of ${payment.amount}`}
              </p>
              {!isRefunded && refundTotals && <p className="-mt-1 text-xs text-text-muted">{refundTotals.left} left to refund</p>}
              <ul className="flex flex-col divide-y divide-danger/15">
                {refunds.map(r => (
                  <li key={r.id} className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold tabular-nums text-text-primary">{r.amount}</span>
                      <span className="block text-xs text-text-secondary truncate">
                        {[r.reason, new Date(r.when).toLocaleDateString([], { day: 'numeric', month: 'short' }), r.chainLabel].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    {r.txUrl && (
                      <a href={r.txUrl} target="_blank" rel="noreferrer" aria-label="View refund transaction"
                        className="shrink-0 inline-flex items-center gap-1 min-h-[32px] text-xs text-danger font-medium">
                        View <ExternalLink className="size-3.5" />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Sheet>
  )
}
