/**
 * OverviewView — clean merchant dashboard. Every number and action appears exactly once.
 */
import React from 'react'
import {
  QrCode, CreditCard, Link2, FileText, Clock, ChevronRight,
} from 'lucide-react'
import { motion } from 'framer-motion'
import type { Payment, ReactNode } from './types'
import { formatTime } from './types'
import { Skeleton, ChainLogo, StatusDot, Divider, FadeUp } from './primitives'

// ─── Local helpers ────────────────────────────────────────────────────────────

function PaymentRow({ payment, onClick }: { payment: Payment; onClick: (p: Payment) => void }) {
  const statusLabel =
    payment.status === 'to_settle' ? 'To settle'
    : payment.status === 'refunded' ? 'Refunded'
    : 'Received'

  return (
    <button
      type="button"
      aria-label={`Payment from ${payment.from}`}
      onClick={() => onClick(payment)}
      className="w-full flex items-center gap-3 py-3 active:bg-border/20 rounded-xl -mx-1 px-1 transition-colors"
    >
      <ChainLogo src={payment.chainLogo} label={payment.chainLabel} size={36} />
      <div className="flex-1 min-w-0 text-left">
        <p className="text-sm font-medium text-text-primary truncate">{payment.from}</p>
        <p className="text-xs text-text-muted mt-0.5">{payment.chainLabel} · {formatTime(payment.time)}</p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-sm font-semibold tabular-nums text-text-primary">{payment.amount}</p>
        <div className="flex items-center justify-end gap-1 mt-0.5">
          <StatusDot status={payment.status} />
          <span className="text-[10px] text-text-muted">{statusLabel}</span>
        </div>
      </div>
    </button>
  )
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface OverviewViewProps {
  loading: boolean
  banner?: ReactNode
  periodLabel: string   // "Today" | "Last 7 days"
  collection: {
    total: string        // "$1,248.50"
    trend?: ReactNode
    count: number
    average: string
    customers: number
  }
  toSettle: {
    total: string
    chainCount: number
  }
  refunded: {
    total: string
    count: number
  }
  recent: Payment[]

  onShowQr: () => void
  onCharge: () => void
  onPaymentLink: () => void
  onSendBill: () => void
  onRequests: () => void
  onToSettle: () => void
  onRefunded: () => void
  onSeeAllPayments: () => void
  onPayment: (p: Payment) => void
}

// ─── Component ────────────────────────────────────────────────────────────────

export function OverviewView({
  loading,
  banner,
  periodLabel,
  collection,
  toSettle,
  refunded,
  recent,
  onShowQr,
  onCharge,
  onPaymentLink,
  onSendBill,
  onRequests,
  onToSettle,
  onRefunded,
  onSeeAllPayments,
  onPayment,
}: OverviewViewProps) {
  const hasSettle = toSettle.chainCount > 0

  return (
    <div className="flex flex-col gap-5 pb-8">

      {/* Optional setup / alert banner */}
      {banner}

      {/* ── Hero card ──────────────────────────────────────────────────── */}
      <FadeUp delay={0.04} className="mx-5">
        <div className="rounded-3xl bg-card border border-border/60 p-5">
          <p className="text-xs font-semibold text-text-muted tracking-widest uppercase">
            {periodLabel === 'Today' ? "Today's collection" : `Collection · ${periodLabel}`}
          </p>

          {loading ? (
            <Skeleton className="mt-3 h-11 w-44 rounded-xl" />
          ) : (
            <motion.div
              key={collection.total}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
              className="mt-2 flex items-baseline gap-2"
            >
              <span className="text-4xl font-bold tabular-nums text-text-primary leading-none">
                {collection.total}
              </span>
              <span className="text-base text-text-muted font-medium">USDC</span>
            </motion.div>
          )}

          {/* Trend chip */}
          {!loading && collection.trend && (
            <div className="mt-2">{collection.trend}</div>
          )}

          {/* One-line stats */}
          {loading ? (
            <Skeleton className="mt-3 h-4 w-48 rounded" />
          ) : (
            <p className="mt-3 text-xs text-text-muted tabular-nums">
              {collection.count} payments
              {' · '}avg {collection.average}
              {' · '}{collection.customers} customers
            </p>
          )}
        </div>
      </FadeUp>

      {/* ── Status tiles: To settle + Refunded ─────────────────────────── */}
      <FadeUp delay={0.08} className="mx-5">
        <div className="grid grid-cols-2 gap-3">

          {/* To settle */}
          <button
            type="button"
            aria-label="View payments to settle"
            onClick={onToSettle}
            className={[
              'rounded-2xl p-4 text-left active:scale-[0.97] transition-all border',
              hasSettle
                ? 'bg-warning/10 border-warning/20'
                : 'bg-card border-border/50',
            ].join(' ')}
          >
            <p className={`text-[10px] font-semibold uppercase tracking-wider ${hasSettle ? 'text-warning' : 'text-text-muted'}`}>
              To settle
            </p>
            {loading ? (
              <Skeleton className="mt-2 h-6 w-20 rounded" />
            ) : (
              <>
                <p className={`mt-1.5 text-lg font-bold tabular-nums leading-none ${hasSettle ? 'text-warning' : 'text-text-secondary'}`}>
                  {toSettle.total}
                </p>
                <p className="mt-1 text-[11px] text-text-muted">
                  {hasSettle ? `on ${toSettle.chainCount} chain${toSettle.chainCount > 1 ? 's' : ''}` : 'All on Arc'}
                </p>
              </>
            )}
            <ChevronRight className={`size-3.5 mt-2 ${hasSettle ? 'text-warning' : 'text-text-muted'}`} />
          </button>

          {/* Refunded */}
          <button
            type="button"
            aria-label="View refunded payments"
            onClick={onRefunded}
            className="rounded-2xl p-4 text-left bg-card border border-border/50 active:scale-[0.97] transition-all"
          >
            <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              Refunded
            </p>
            {loading ? (
              <Skeleton className="mt-2 h-6 w-20 rounded" />
            ) : (
              <>
                <p className="mt-1.5 text-lg font-bold tabular-nums leading-none text-text-secondary">
                  {refunded.total}
                </p>
                <p className="mt-1 text-[11px] text-text-muted">
                  {refunded.count > 0
                    ? `${refunded.count} refund${refunded.count > 1 ? 's' : ''}`
                    : periodLabel === 'Today' ? 'None today' : 'None'}
                </p>
              </>
            )}
            <ChevronRight className="size-3.5 mt-2 text-text-muted" />
          </button>

        </div>
      </FadeUp>

      {/* ── Primary actions ─────────────────────────────────────────────── */}
      <FadeUp delay={0.12} className="mx-5">
        <div className="grid grid-cols-2 gap-3">

          <button
            type="button"
            aria-label="Show QR code"
            onClick={onShowQr}
            className="flex flex-col items-center justify-center gap-2.5 rounded-2xl bg-brand min-h-[88px] p-4 active:scale-[0.96] transition-all"
          >
            <QrCode className="size-6 text-white" />
            <span className="text-sm font-semibold text-white">Show QR</span>
          </button>

          <button
            type="button"
            aria-label="Charge a customer"
            onClick={onCharge}
            className="flex flex-col items-center justify-center gap-2.5 rounded-2xl bg-card border border-border/60 min-h-[88px] p-4 active:scale-[0.96] transition-all hover:border-border"
          >
            <CreditCard className="size-6 text-text-secondary" />
            <span className="text-sm font-semibold text-text-secondary">Charge</span>
          </button>

        </div>
      </FadeUp>

      {/* ── Get paid strip ──────────────────────────────────────────────── */}
      <FadeUp delay={0.14} className="mx-5">
        <div className="flex items-stretch gap-2">
          {([
            { Icon: Link2,     label: 'Payment link', onClick: onPaymentLink },
            { Icon: FileText,  label: 'Send bill',    onClick: onSendBill    },
            { Icon: Clock,     label: 'Requests',     onClick: onRequests    },
          ] as const).map(({ Icon, label, onClick }) => (
            <button
              key={label}
              type="button"
              aria-label={label}
              onClick={onClick}
              className="flex-1 flex flex-col items-center gap-2 py-3.5 rounded-2xl bg-card border border-border/60 active:scale-[0.96] transition-all hover:border-border"
            >
              <span className="inline-flex items-center justify-center size-9 rounded-xl bg-brand/10 text-brand-text">
                <Icon className="size-4" />
              </span>
              <span className="text-[11px] font-medium text-text-secondary text-center leading-tight">{label}</span>
            </button>
          ))}
        </div>
      </FadeUp>

      <Divider className="mx-5" />

      {/* ── Recent payments ─────────────────────────────────────────────── */}
      <FadeUp delay={0.16} className="mx-5">
        <div className="flex items-center justify-between mb-1">
          <p className="text-sm font-semibold text-text-primary">Recent payments</p>
          <button
            type="button"
            onClick={onSeeAllPayments}
            className="text-xs text-brand-text font-medium flex items-center gap-0.5 active:opacity-70 py-1"
          >
            See all <ChevronRight className="size-3.5" />
          </button>
        </div>

        {loading ? (
          <div className="flex flex-col gap-3 mt-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-9 rounded-full" />
                <div className="flex-1">
                  <Skeleton className="h-3.5 w-32 mb-1.5" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
        ) : recent.length === 0 ? (
          <div className="mt-6 flex flex-col items-center text-center py-8">
            <span className="inline-flex items-center justify-center size-12 rounded-2xl bg-surface border border-border mb-3">
              <CreditCard className="size-5 text-text-muted" />
            </span>
            <p className="text-sm font-medium text-text-secondary">No payments yet</p>
            <p className="text-xs text-text-muted mt-1">Share your QR code to receive payments</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {recent.slice(0, 4).map((p, i) => (
              <React.Fragment key={p.id}>
                {i > 0 && <Divider className="my-0.5" />}
                <PaymentRow payment={p} onClick={onPayment} />
              </React.Fragment>
            ))}
          </div>
        )}
      </FadeUp>

    </div>
  )
}
