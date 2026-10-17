/**
 * OverviewView — the main merchant dashboard screen.
 * Dominant object: today's collection total. One primary CTA: Show QR.
 */
import React from 'react'
import {
  QrCode, CreditCard, Link2, FileText, Clock, ArrowDownToLine,
  ChevronRight, BarChart2, Mic, User, LifeBuoy,
} from 'lucide-react'
import { motion } from 'framer-motion'
import type { Payment, ReactNode } from './types'
import { formatTime } from './types'
import { Skeleton, ChainLogo, StatusDot, Divider, FadeUp } from './primitives'

// ─── Sub-components ──────────────────────────────────────────────────────────

function QuickActionTile({
  Icon,
  label,
  primary = false,
  onClick,
}: {
  Icon: React.ElementType
  label: string
  primary?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`flex flex-col items-center justify-center gap-2 rounded-2xl p-4 min-h-[80px] active:scale-[0.96] transition-all ${
        primary
          ? 'bg-brand text-white'
          : 'bg-surface border border-border text-text-secondary hover:border-text-muted'
      }`}
    >
      <Icon className="size-5" />
      <span className="text-xs font-medium text-center leading-tight">{label}</span>
    </button>
  )
}

function CompactActionBtn({
  Icon,
  label,
  onClick,
}: {
  Icon: React.ElementType
  label: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex flex-col items-center gap-1.5 min-w-[60px] active:scale-95 transition-all"
    >
      <span className="inline-flex items-center justify-center size-11 rounded-2xl bg-surface border border-border text-text-secondary">
        <Icon className="size-4" />
      </span>
      <span className="text-[10px] text-text-muted font-medium text-center leading-tight">{label}</span>
    </button>
  )
}

function ManageChip({
  Icon,
  label,
  onClick,
}: {
  Icon: React.ElementType
  label: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex items-center gap-2 px-4 py-3 rounded-2xl bg-surface border border-border text-text-secondary hover:border-text-muted active:scale-[0.97] transition-all"
    >
      <Icon className="size-4 shrink-0" />
      <span className="text-xs font-medium whitespace-nowrap">{label}</span>
    </button>
  )
}

function PaymentRow({
  payment,
  onClick,
}: {
  payment: Payment
  onClick: (p: Payment) => void
}) {
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
          <span className="text-[10px] text-text-muted capitalize">{payment.status === 'to_settle' ? 'To settle' : 'Received'}</span>
        </div>
      </div>
    </button>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

export interface OverviewViewProps {
  loading: boolean
  today: {
    total: string       // pre-formatted, e.g. "$1,248.50"
    count: number
    average: string
    customers: number
  }
  onArc: string         // received on Arc today, e.g. "$980.00"
  toSettle: {
    total: string
    chainCount: number
  }
  recent: Payment[]
  /** Optional trend chip rendered directly under the big total */
  trend?: ReactNode
  banner?: ReactNode

  onShowQr: () => void
  onCharge: () => void
  onPaymentLink: () => void
  onSendBill: () => void
  onRequests: () => void
  onSettle: () => void
  onSeeAllPayments: () => void
  onPayment: (p: Payment) => void
  onInsights: () => void
  onVoiceAlerts: () => void
  onProfile: () => void
  onStatement?: () => void
  onHelp?: () => void
}

export function OverviewView({
  loading,
  today,
  onArc,
  toSettle,
  recent,
  trend,
  banner,
  onShowQr,
  onCharge,
  onPaymentLink,
  onSendBill,
  onRequests,
  onSettle,
  onSeeAllPayments,
  onPayment,
  onInsights,
  onVoiceAlerts,
  onProfile,
  onStatement,
  onHelp,
}: OverviewViewProps) {
  return (
    <div className="flex flex-col gap-5 pb-8">
      {/* Optional setup / alert banner */}
      {banner}

      {/* ── Hero: today's collection ────────────────────────────────────── */}
      <FadeUp delay={0.04} className="mx-5">
        <div className="rounded-3xl bg-card border border-border p-5">
          <p className="text-xs font-semibold text-text-muted tracking-widest uppercase">
            Today&apos;s collection
          </p>

          {loading ? (
            <Skeleton className="mt-3 h-12 w-48" />
          ) : (
            <motion.div
              key={today.total}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
              className="mt-2 flex items-baseline gap-2"
            >
              <span className="display text-4xl font-bold tabular-nums text-text-primary">
                {today.total}
              </span>
              <span className="text-base text-text-muted font-medium">USDC</span>
            </motion.div>
          )}

          {!loading && trend && <div className="mt-2">{trend}</div>}

          {/* Stat chips */}
          <div className="mt-4 flex items-center gap-3 flex-wrap">
            {loading ? (
              <>
                <Skeleton className="h-7 w-20 rounded-xl" />
                <Skeleton className="h-7 w-20 rounded-xl" />
                <Skeleton className="h-7 w-20 rounded-xl" />
              </>
            ) : (
              <>
                <Chip label={`${today.count} orders`} />
                <Chip label={`avg ${today.average}`} />
                <Chip label={`${today.customers} customers`} />
              </>
            )}
          </div>
        </div>
      </FadeUp>

      {/* ── Split strip: On Arc | To settle ────────────────────────────── */}
      <FadeUp delay={0.08} className="mx-5">
        <div className="grid grid-cols-2 gap-3">
          {/* On Arc */}
          <div className="rounded-2xl bg-surface border border-border p-4">
            <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">On Arc today</p>
            {loading ? (
              <Skeleton className="mt-2 h-6 w-20" />
            ) : (
              <p className="mt-1.5 text-lg font-bold tabular-nums text-text-primary display">{onArc}</p>
            )}
          </div>

          {/* To settle */}
          <div className="rounded-2xl bg-brand/10 border border-brand/20 p-4 flex flex-col justify-between">
            <p className="text-[10px] font-semibold text-brand-text uppercase tracking-wider">To settle</p>
            {loading ? (
              <Skeleton className="mt-2 h-6 w-20 bg-brand/20" />
            ) : (
              <>
                <p className="mt-1 text-lg font-bold tabular-nums text-brand-text display">{toSettle.total}</p>
                {toSettle.chainCount > 0 ? <button
                  type="button"
                  aria-label="Settle now"
                  onClick={onSettle}
                  className="mt-2 self-start flex items-center gap-1 rounded-full bg-brand px-2.5 py-1 text-[10px] font-semibold text-white active:scale-95 transition-all"
                >
                  Settle now
                  <ChevronRight className="size-3" />
                </button> : <p className="mt-2 text-[11px] text-text-muted">All on Arc</p>}
              </>
            )}
          </div>
        </div>
      </FadeUp>

      {/* ── Primary actions ─────────────────────────────────────────────── */}
      <FadeUp delay={0.12} className="mx-5">
        <div className="grid grid-cols-2 gap-3">
          <QuickActionTile Icon={QrCode} label="Show QR" primary onClick={onShowQr} />
          <QuickActionTile Icon={CreditCard} label="Charge" onClick={onCharge} />
        </div>
      </FadeUp>

      {/* ── Secondary "get paid" strip ──────────────────────────────────── */}
      <FadeUp delay={0.14}>
        <div className="flex items-center justify-around px-8 py-1">
          <CompactActionBtn Icon={Link2}           label="Payment link" onClick={onPaymentLink} />
          <CompactActionBtn Icon={FileText}        label="Send bill"    onClick={onSendBill} />
          <CompactActionBtn Icon={Clock}           label="Requests"     onClick={onRequests} />
          <CompactActionBtn Icon={ArrowDownToLine} label="Settle"       onClick={onSettle} />
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
            className="text-xs text-brand-text font-medium flex items-center gap-0.5 active:opacity-70"
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
            <p className="text-sm font-medium text-text-secondary">No payments yet today</p>
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

      <Divider className="mx-5" />

      {/* ── Manage row ──────────────────────────────────────────────────── */}
      <FadeUp delay={0.18} className="mx-5">
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Manage</p>
        <div className="flex flex-wrap gap-2">
          <ManageChip Icon={BarChart2} label="Insights"      onClick={onInsights} />
          <ManageChip Icon={Mic}       label="Voice alerts"  onClick={onVoiceAlerts} />
          {onStatement && <ManageChip Icon={FileText} label="Statement" onClick={onStatement} />}
          <ManageChip Icon={User}      label="Business profile" onClick={onProfile} />
          {onHelp && <ManageChip Icon={LifeBuoy} label="Help" onClick={onHelp} />}
        </div>
      </FadeUp>
    </div>
  )
}

// ─── Stat chip helper ────────────────────────────────────────────────────────
function Chip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-bg border border-border px-2.5 py-1 text-xs text-text-secondary font-medium tabular-nums">
      {label}
    </span>
  )
}
