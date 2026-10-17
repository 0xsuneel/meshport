/**
 * PaymentDetailSheet — bottom sheet with payment detail + settlement action.
 * Amount hero, 3-step status timeline, details rows, optional "Settle now" CTA.
 */
import React from 'react'
import { X, ExternalLink, ArrowDownToLine, CheckCircle2, Clock, Wallet } from 'lucide-react'
import type { Payment } from './types'
import { formatTime } from './types'
import { Sheet, PrimaryBtn, ChainLogo, Divider } from './primitives'

export interface PaymentDetailSheetProps {
  payment: Payment | null
  explorerUrl?: string
  onClose: () => void
  onSettle: (p: Payment) => void
}

// ─── Timeline step ───────────────────────────────────────────────────────────

function TimelineStep({
  Icon,
  label,
  sublabel,
  state,  // 'done' | 'active' | 'upcoming'
  last = false,
}: {
  Icon: React.ElementType
  label: string
  sublabel?: string
  state: 'done' | 'active' | 'upcoming'
  last?: boolean
}) {
  return (
    <div className="flex items-start gap-3">
      {/* Dot + vertical line */}
      <div className="flex flex-col items-center">
        <span
          className={`inline-flex items-center justify-center size-8 rounded-full shrink-0 ${
            state === 'done'
              ? 'bg-success/15 text-success'
              : state === 'active'
              ? 'bg-brand/15 text-brand-text'
              : 'bg-border/40 text-text-muted'
          }`}
        >
          <Icon className="size-4" />
        </span>
        {!last && <div className="w-px flex-1 bg-border/60 mt-1 min-h-[24px]" />}
      </div>

      {/* Text */}
      <div className="pb-5 pt-1">
        <p
          className={`text-sm font-medium ${
            state === 'upcoming' ? 'text-text-muted' : 'text-text-primary'
          }`}
        >
          {label}
        </p>
        {sublabel && (
          <p className="text-xs text-text-muted mt-0.5">{sublabel}</p>
        )}
      </div>
    </div>
  )
}

// ─── Detail row ──────────────────────────────────────────────────────────────

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-xs text-text-muted">{label}</span>
      <span className={`text-xs font-medium text-text-secondary ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

export function PaymentDetailSheet({
  payment,
  explorerUrl,
  onClose,
  onSettle,
}: PaymentDetailSheetProps) {
  const isArc = payment?.chainLabel === 'Arc'

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
            <p className="display text-4xl font-bold tabular-nums text-text-primary mt-1">
              {payment.amount}
            </p>
            <p className="text-sm text-text-muted">{payment.chainLabel} · {formatTime(payment.time)}</p>
          </div>

          <Divider className="my-4" />

          {/* Status timeline */}
          <div className="px-1 mb-2">
            <TimelineStep
              Icon={CheckCircle2}
              label={`Paid on ${payment.chainLabel}`}
              sublabel={`From ${payment.from}`}
              state="done"
            />
            {!isArc && (
              <TimelineStep
                Icon={Clock}
                label="Waiting to settle"
                sublabel="Funds waiting on originating chain"
                state={payment.status === 'to_settle' ? 'active' : 'done'}
              />
            )}
            <TimelineStep
              Icon={Wallet}
              label="In your Arc balance"
              sublabel={payment.status === 'received' ? 'Settled' : 'Settle to move funds to Arc'}
              state={payment.status === 'received' ? 'done' : 'upcoming'}
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

          {/* Settle CTA */}
          {payment.status === 'to_settle' && (
            <div className="mt-4">
              <PrimaryBtn
                onClick={() => onSettle(payment)}
              >
                <span className="flex items-center justify-center gap-2">
                  <ArrowDownToLine className="size-4" />
                  Settle now
                </span>
              </PrimaryBtn>
            </div>
          )}
        </div>
      )}
    </Sheet>
  )
}
