/**
 * PaymentDetailSheet — bottom sheet with payment detail, timeline, and actions.
 * Supports received, to_settle, and refunded statuses.
 */
import React from 'react'
import { X, ExternalLink, ArrowDownToLine, CheckCircle2, Clock, Wallet, RotateCcw, FileText } from 'lucide-react'
import type { Payment } from './types'
import { formatTime } from './types'
import { Sheet, PrimaryBtn, GhostBtn, ChainLogo, Divider } from './primitives'

export interface RefundInfo {
  amount: string
  reason: string
  when: string    // ISO
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
  /** Present when payment has already been refunded */
  refund?: RefundInfo
}

// ─── Timeline step ────────────────────────────────────────────────────────────

function TimelineStep({
  Icon, label, sublabel, state, last = false,
}: {
  Icon: React.ElementType
  label: string
  sublabel?: string
  state: 'done' | 'active' | 'upcoming'
  last?: boolean
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex flex-col items-center">
        <span className={`inline-flex items-center justify-center size-8 rounded-full shrink-0 ${
          state === 'done'   ? 'bg-success/15 text-success'
          : state === 'active' ? 'bg-brand/15 text-brand-text'
          : 'bg-border/40 text-text-muted'
        }`}>
          <Icon className="size-4" />
        </span>
        {!last && <div className="w-px flex-1 bg-border/60 mt-1 min-h-[24px]" />}
      </div>
      <div className="pb-5 pt-1">
        <p className={`text-sm font-medium ${state === 'upcoming' ? 'text-text-muted' : 'text-text-primary'}`}>
          {label}
        </p>
        {sublabel && <p className="text-xs text-text-muted mt-0.5">{sublabel}</p>}
      </div>
    </div>
  )
}

// ─── Detail row ───────────────────────────────────────────────────────────────

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-xs text-text-muted">{label}</span>
      <span className={`text-xs font-medium text-text-secondary ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function PaymentDetailSheet({
  payment,
  explorerUrl,
  onClose,
  onSettle,
  onRefund,
  onReceipt,
  refundNote,
  refund,
}: PaymentDetailSheetProps) {
  const isArc      = payment?.chainLabel === 'Arc'
  const isRefunded = payment?.status === 'refunded'

  return (
    <Sheet open={!!payment} onClose={onClose}>
      {payment && (
        <div className="flex flex-col px-5 pb-6 pt-2 overflow-y-auto max-h-[88dvh]">

          {/* Header */}
          <div className="flex items-center justify-between mb-5">
            <p className="text-sm font-semibold text-text-secondary">Payment detail</p>
            <button
              type="button"
              aria-label="Close sheet"
              onClick={onClose}
              className="size-8 flex items-center justify-center rounded-xl text-text-muted hover:bg-border/40 transition-colors"
            >
              <X className="size-4" />
            </button>
          </div>

          {/* Amount hero */}
          <div className="flex flex-col items-center py-4 gap-2">
            <ChainLogo src={payment.chainLogo} label={payment.chainLabel} size={44} />
            {isRefunded && (
              <span className="text-[10px] font-bold uppercase tracking-wider text-danger">Refunded</span>
            )}
            <p className={`display text-4xl font-bold tabular-nums mt-1 ${isRefunded ? 'text-danger line-through opacity-60' : 'text-text-primary'}`}>
              {payment.amount}
            </p>
            <p className="text-sm text-text-muted">{payment.chainLabel} · {formatTime(payment.time)}</p>
          </div>

          <Divider className="my-4" />

          {/* Status timeline */}
          <div className="px-1 mb-2">
            <TimelineStep
              Icon={isRefunded ? RotateCcw : CheckCircle2}
              label={isRefunded ? `Paid then refunded on ${payment.chainLabel}` : `Paid on ${payment.chainLabel}`}
              sublabel={`From ${payment.from}`}
              state="done"
            />
            {!isArc && !isRefunded && (
              <TimelineStep
                Icon={Clock}
                label="Waiting to settle"
                sublabel="Funds waiting on originating chain"
                state={payment.status === 'to_settle' ? 'active' : 'done'}
              />
            )}
            <TimelineStep
              Icon={Wallet}
              label={isRefunded ? 'Returned to customer' : 'In your Arc balance'}
              sublabel={
                isRefunded
                  ? `Refunded ${refund ? refund.amount : payment.amount}`
                  : payment.status === 'received'
                  ? 'Settled'
                  : 'Settle to move funds to Arc'
              }
              state={payment.status === 'received' || isRefunded ? 'done' : 'upcoming'}
              last
            />
          </div>

          <Divider className="my-2" />

          {/* Details rows */}
          <div className="px-1">
            <DetailRow label="From"   value={payment.from} mono />
            <Divider />
            <DetailRow label="Chain"  value={payment.chainLabel} />
            <Divider />
            <DetailRow label="Amount" value={payment.amount} />
            <Divider />
            <DetailRow label="Time"   value={new Date(payment.time).toLocaleString()} />
            {payment.order && (
              <>
                <Divider />
                <DetailRow label="Order" value={payment.order} mono />
              </>
            )}
          </div>

          {/* Refund info block */}
          {isRefunded && refund && (
            <>
              <Divider className="my-4" />
              <div className="rounded-2xl bg-danger/10 border border-danger/20 px-4 py-4 flex flex-col gap-2">
                <p className="text-xs font-semibold text-danger uppercase tracking-wider">Refund details</p>
                <DetailRow label="Amount"  value={refund.amount} />
                <Divider />
                <DetailRow label="Reason"  value={refund.reason} />
                <Divider />
                <DetailRow label="Date"    value={new Date(refund.when).toLocaleDateString()} />
                {refund.txUrl && (
                  <a
                    href={refund.txUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 flex items-center gap-1.5 text-xs text-danger font-medium"
                  >
                    View refund transaction
                    <ExternalLink className="size-3.5" />
                  </a>
                )}
              </div>
            </>
          )}

          {/* Explorer link */}
          {explorerUrl && (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-4 flex items-center justify-center gap-1.5 text-xs text-brand-text font-medium py-2"
            >
              View transaction
              <ExternalLink className="size-3.5" />
            </a>
          )}

          {/* Settle CTA (to_settle only) */}
          {payment.status === 'to_settle' && (
            <div className="mt-4">
              <PrimaryBtn onClick={() => onSettle(payment)}>
                <span className="flex items-center justify-center gap-2">
                  <ArrowDownToLine className="size-4" />
                  Settle now
                </span>
              </PrimaryBtn>
            </div>
          )}

          {/* Receipt + Refund pair (received or refunded) */}
          {(onReceipt || onRefund) && (
            <div className="mt-4 flex gap-3">
              {onReceipt && (
                <GhostBtn onClick={onReceipt} className="flex items-center justify-center gap-2">
                  <FileText className="size-4" />
                  Send receipt
                </GhostBtn>
              )}
              {!isRefunded && onRefund && (
                <button
                  type="button"
                  onClick={onRefund}
                  className="flex-1 flex items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-medium border-2 border-danger text-danger hover:bg-danger/10 active:scale-[0.98] transition-all"
                >
                  <RotateCcw className="size-4" />
                  Refund
                </button>
              )}
            </div>
          )}
          {!isRefunded && !onRefund && refundNote && (
            <p className="mt-3 text-center text-xs text-text-muted leading-relaxed">{refundNote}</p>
          )}
        </div>
      )}
    </Sheet>
  )
}
