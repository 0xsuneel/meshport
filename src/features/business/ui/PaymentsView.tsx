/**
 * PaymentsView — searchable, filterable list of all payments.
 * Grouped by day with a day-total header row.
 */
import React, { useState, useMemo } from 'react'
import { Search, CreditCard } from 'lucide-react'
import type { Payment } from './types'
import { groupByDay, formatTime } from './types'
import { Skeleton, ChainLogo, StatusDot, Divider } from './primitives'
import { ExportButton } from './ExportButton'

export interface PaymentsViewProps {
  loading: boolean
  payments: Payment[]
  onPayment: (p: Payment) => void
  /** When provided, shows an Export CSV button beside the search box */
  onExport?: () => void
}

type Filter = 'all' | 'received' | 'to_settle' | 'refunded'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all',       label: 'All' },
  { id: 'received',  label: 'Received' },
  { id: 'to_settle', label: 'To settle' },
  { id: 'refunded',  label: 'Refunded' },
]

function PaymentRow({ payment, onClick }: { payment: Payment; onClick: (p: Payment) => void }) {
  return (
    <button
      type="button"
      aria-label={`Payment from ${payment.from}`}
      onClick={() => onClick(payment)}
      className="w-full flex items-center gap-3 py-3.5 px-1 -mx-1 rounded-xl active:bg-border/20 transition-colors"
    >
      <ChainLogo src={payment.chainLogo} label={payment.chainLabel} size={38} />
      <div className="flex-1 min-w-0 text-left">
        <p className="text-sm font-medium text-text-primary truncate">{payment.from}</p>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-xs text-text-muted">{payment.chainLabel}</span>
          {payment.order && (
            <>
              <span className="text-text-muted opacity-30">·</span>
              <span className="text-xs text-text-muted truncate max-w-[80px]">{payment.order}</span>
            </>
          )}
        </div>
      </div>
      <div className="text-right shrink-0">
        <p className="text-sm font-semibold tabular-nums text-text-primary">{payment.amount}</p>
        <div className="flex items-center justify-end gap-1 mt-0.5">
          <StatusDot status={payment.status} />
          <span className="text-[10px] text-text-muted">{formatTime(payment.time)}</span>
        </div>
      </div>
    </button>
  )
}

export function PaymentsView({ loading, payments, onPayment, onExport }: PaymentsViewProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    return payments.filter((p) => {
      const matchFilter = filter === 'all' || p.status === filter
      const matchQuery =
        !q ||
        p.from.toLowerCase().includes(q) ||
        p.chainLabel.toLowerCase().includes(q) ||
        (p.order?.toLowerCase().includes(q) ?? false)
      return matchFilter && matchQuery
    })
  }, [payments, query, filter])

  const groups = useMemo(() => groupByDay(filtered), [filtered])

  return (
    <div className="flex flex-col gap-4 pb-8">
      {/* Search + optional export */}
      <div className="mx-5 mt-2 flex items-center gap-2">
        <div className="flex flex-1 min-w-0 items-center gap-2 bg-surface border border-border rounded-2xl px-3.5 py-3">
          <Search className="size-4 text-text-muted shrink-0" />
          <input
            type="search"
            placeholder="Search payments..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 min-w-0 w-full bg-transparent text-sm text-text-primary placeholder:text-text-muted outline-none"
          />
        </div>
        {onExport && <ExportButton onClick={onExport} label="CSV" />}
      </div>

      {/* Filter pills */}
      <div className="flex gap-2 px-5 no-scrollbar overflow-x-auto">
        {FILTERS.map(({ id, label }) => {
          const active = filter === id
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(id)}
              className={`shrink-0 rounded-full px-4 py-2 text-xs font-semibold transition-colors min-h-[36px] ${
                active
                  ? 'bg-brand text-white'
                  : 'bg-surface border border-border text-text-secondary hover:border-text-muted'
              }`}
            >
              {label}
            </button>
          )
        })}
      </div>

      {/* List */}
      {loading ? (
        <div className="flex flex-col gap-4 mx-5">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="size-10 rounded-full" />
              <div className="flex-1">
                <Skeleton className="h-3.5 w-36 mb-2" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center text-center py-16 mx-5">
          <span className="inline-flex items-center justify-center size-14 rounded-2xl bg-surface border border-border mb-3">
            <CreditCard className="size-6 text-text-muted" />
          </span>
          <p className="text-sm font-medium text-text-secondary">No payments found</p>
          <p className="text-xs text-text-muted mt-1">
            {query ? 'Try a different search' : 'Payments will appear here once received'}
          </p>
        </div>
      ) : (
        <div className="mx-5 flex flex-col gap-0">
          {groups.map((group, gi) => (
            <div key={group.day}>
              {/* Day header */}
              {gi > 0 && <Divider className="my-2" />}
              <div className="flex items-center justify-between py-2">
                <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">{group.day}</span>
                <span className="text-xs font-semibold tabular-nums text-text-secondary">{group.total}</span>
              </div>
              {/* Day items */}
              {group.items.map((p, i) => (
                <React.Fragment key={p.id}>
                  {i > 0 && <Divider className="my-0" />}
                  <PaymentRow payment={p} onClick={onPayment} />
                </React.Fragment>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
