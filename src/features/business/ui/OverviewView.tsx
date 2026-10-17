/**
 * OverviewView — the Business home ("wallet card" layout): a brand card with
 * the period's collection, four round quick actions, a settle bar when money
 * waits on other chains, and recent payments. Every number appears once.
 */
import React from 'react'
import { ChevronDown, CreditCard } from 'lucide-react'
import { ActionIcon } from '@/components/ui/ActionIcon'
import { motion } from 'framer-motion'
import type { Payment, ReactNode } from './types'
import { formatTime } from './types'
import { Skeleton, ChainLogo, FadeUp } from './primitives'

// ─── Local helpers ────────────────────────────────────────────────────────────

const initials = (name: string) => {
  if (/^0x/i.test(name)) return '0x'
  const parts = name.replace(/\.arc$/, '').split(/[\s._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase()
}

function PaymentRow({ payment, onClick }: { payment: Payment; onClick: (p: Payment) => void }) {
  const tag = payment.status === 'to_settle' ? ' · to settle' : payment.status === 'refunded' ? ' · refunded' : ''
  return (
    <button
      type="button"
      aria-label={`Payment from ${payment.from}`}
      onClick={() => onClick(payment)}
      className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-border/20 transition-colors"
    >
      <span className="relative shrink-0">
        <span className="flex items-center justify-center size-9 rounded-full bg-surface border border-border text-xs font-semibold text-text-secondary">
          {initials(payment.from)}
        </span>
        <ChainLogo src={payment.chainLogo} label={payment.chainLabel} size={16} className="absolute -bottom-0.5 -right-0.5 ring-2 ring-card rounded-full" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-text-primary truncate">{payment.from}</span>
        <span className="block text-xs text-text-muted truncate">
          {payment.chainLabel}{payment.order ? ` · ${payment.order}` : ''} · {formatTime(payment.time)}{tag}
        </span>
      </span>
      <span className={`shrink-0 text-sm font-semibold tabular-nums ${payment.status === 'refunded' ? 'text-text-muted line-through' : 'text-brand-text'}`}>
        +{payment.amount}
      </span>
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
    /** Chains holding the money, for the logo stack and "On Base, …" line */
    chains?: { label: string; logo?: string }[]
    /** Still reading the other chains' balances */
    checking?: boolean
    /** Arc logo for the "all on Arc" state */
    arcLogo?: string
    /** Staff mode: settling is the owner's, so no bar */
    hidden?: boolean
  }
  refunded: {
    total: string
    count: number
  }
  recent: Payment[]

  onShowQr: () => void
  /** Amount → counter QR + shareable link for one order */
  onReceive: () => void
  /** Balance: Arc balance, chains to settle, cash out */
  onBalance?: () => void
  /** All payments (and the business's own requests) */
  onPayments?: () => void
  /** Everyone who paid, with their history */
  onCustomers?: () => void
  onToSettle: () => void
  onRefunded: () => void
  onSeeAllPayments: () => void
  onPayment: (p: Payment) => void
  /** Opens the period picker from the card's chip (no chip when omitted) */
  onPeriod?: () => void
}

// ─── Component ────────────────────────────────────────────────────────────────

export function OverviewView({
  loading,
  banner,
  periodLabel,
  collection,
  toSettle,
  recent,
  onShowQr,
  onReceive,
  onBalance,
  onPayments,
  onCustomers,
  onToSettle,
  onSeeAllPayments,
  onPayment,
  onPeriod,
}: OverviewViewProps) {
  const hasSettle = toSettle.chainCount > 0
  const chains = toSettle.chains ?? []
  const actions = [
    { icon: 'qr' as const,      label: 'Show QR',  onClick: onShowQr },
    { icon: 'receive' as const, label: 'Receive',  onClick: onReceive },
    ...(onPayments ? [{ icon: 'list' as const, label: 'Payments', onClick: onPayments }] : []),
    ...(onCustomers ? [{ icon: 'bulk' as const, label: 'Customers', onClick: onCustomers }] : []),
    ...(onBalance ? [{ icon: 'wallet' as const, label: 'Balance', onClick: onBalance }] : []),
  ]

  return (
    <div className="flex flex-col gap-4 pb-8">
      {banner}

      {/* ── Collection card ─────────────────────────────────────────────── */}
      <FadeUp delay={0.04} className="mx-5">
        <div className="rounded-3xl bg-brand text-white p-5 flex flex-col gap-3.5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] text-white/85">
              {periodLabel === 'Today' ? "Today's collection" : 'Collection'}
            </p>
            {onPeriod && (
              <button type="button" onClick={onPeriod} aria-label="Change period"
                className="inline-flex items-center gap-1 min-h-[32px] px-3 rounded-full bg-white/15 text-xs font-semibold text-white active:bg-white/25 transition-colors">
                {periodLabel} <ChevronDown className="size-3.5" />
              </button>
            )}
          </div>
          {loading ? (
            <Skeleton className="h-10 w-44 rounded-xl bg-white/20" />
          ) : (
            <motion.p
              key={collection.total}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22 }}
              className="text-[40px] font-bold tabular-nums leading-none tracking-tight"
            >
              {collection.total}
            </motion.p>
          )}
          {loading ? (
            <Skeleton className="h-4 w-52 rounded bg-white/20" />
          ) : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-white/90">
              <span><b className="font-semibold text-white">{collection.count}</b> payment{collection.count === 1 ? '' : 's'}</span>
              <span><b className="font-semibold text-white">{collection.customers}</b> customer{collection.customers === 1 ? '' : 's'}</span>
              {collection.count > 0 && <span>avg {collection.average}</span>}
              {collection.trend}
            </div>
          )}
        </div>
      </FadeUp>

      {/* ── Quick actions ───────────────────────────────────────────────── */}
      {/* Same round brand buttons as Home's Pay / Receive / Swap / More. */}
      <FadeUp delay={0.08} className="mx-5">
        <div className={`flex ${actions.length > 2 ? 'justify-between' : 'justify-center gap-12'} w-[95%] mx-auto`}>
          {actions.map(({ icon, label, onClick }) => (
            <button key={label} type="button" onClick={onClick}
              className="flex flex-col items-center gap-2 active:scale-[0.95] transition-transform">
              <span className="flex items-center justify-center rounded-full bg-brand" style={{ width: 55, height: 55 }}>
                <ActionIcon name={icon} size={27} />
              </span>
              <span className="text-xs font-medium text-text-primary leading-none">{label}</span>
            </button>
          ))}
        </div>
      </FadeUp>

      {/* ── Settle bar (always) ──────────────────────────────── */}
      <FadeUp delay={0.12} className="mx-5 flex flex-col gap-2">
        {!toSettle.hidden && <div className="flex items-center gap-3 rounded-2xl bg-card border border-border px-3.5 py-3">
          <span className="flex shrink-0">
            {hasSettle ? chains.slice(0, 3).map((c, i) => (
              <ChainLogo key={c.label} src={c.logo} label={c.label} size={28}
                className={`ring-2 ring-card rounded-full ${i > 0 ? '-ml-2.5' : ''}`} />
            )) : (
              <ChainLogo src={toSettle.arcLogo} label="Arc" size={28} className="rounded-full" />
            )}
          </span>
          <span className="flex-1 min-w-0">
            {toSettle.checking && !hasSettle ? (
              <>
                <Skeleton className="h-4 w-28 mb-1.5" />
                <Skeleton className="h-3 w-36" />
              </>
            ) : (
              <>
                <span className="block text-sm font-semibold text-text-primary">
                  {hasSettle ? `${toSettle.total} to settle` : 'Nothing to settle'}
                </span>
                <span className="block text-xs text-text-muted truncate">
                  {hasSettle
                    ? (chains.length ? `On ${chains.map(c => c.label).join(', ')}` : `On ${toSettle.chainCount} chain${toSettle.chainCount > 1 ? 's' : ''}`)
                    : 'All your USDC is on Arc'}
                </span>
              </>
            )}
          </span>
          <button type="button" onClick={onToSettle}
            className={`shrink-0 min-h-[40px] px-4 rounded-xl text-[13px] font-semibold transition-colors ${hasSettle ? 'bg-brand/10 text-brand-text active:bg-brand/20' : 'bg-surface text-text-secondary active:bg-border/40'}`}>
            {hasSettle ? 'Settle' : 'View'}
          </button>
        </div>}
      </FadeUp>

      {/* ── Recent payments ─────────────────────────────────────────────── */}
      <FadeUp delay={0.16} className="mx-5">
        {/* Heading outside the card, like Home's "Assets". */}
        <div className="flex items-center justify-between mb-3">
          <p className="text-base font-bold text-text-primary">Recent payments</p>
          {recent.length > 0 && (
            <button type="button" onClick={onSeeAllPayments}
              className="text-[15px] font-medium text-brand-text active:opacity-70">
              See all
            </button>
          )}
        </div>
        <div className="rounded-2xl bg-surface border border-border overflow-hidden divide-y divide-border">
          {loading ? (
            <div className="flex flex-col gap-3 px-4 pt-2 pb-4">
              {[0, 1, 2].map(i => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="size-9 rounded-full" />
                  <div className="flex-1"><Skeleton className="h-3.5 w-32 mb-1.5" /><Skeleton className="h-3 w-20" /></div>
                  <Skeleton className="h-4 w-14" />
                </div>
              ))}
            </div>
          ) : recent.length === 0 ? (
            <div className="flex flex-col items-center text-center px-6 pt-4 pb-7">
              <span className="inline-flex items-center justify-center size-12 rounded-2xl bg-surface border border-border mb-3">
                <CreditCard className="size-5 text-text-muted" />
              </span>
              <p className="text-sm font-medium text-text-secondary">No payments yet</p>
              <p className="text-xs text-text-muted mt-1">Show your QR at the counter to get paid</p>
            </div>
          ) : (
            <>{recent.slice(0, 4).map(p => <PaymentRow key={p.id} payment={p} onClick={onPayment} />)}</>
          )}
        </div>
      </FadeUp>
    </div>
  )
}
