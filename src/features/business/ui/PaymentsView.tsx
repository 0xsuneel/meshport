/**
 * PaymentsView — searchable, filterable list of all payments.
 * Grouped by day with a day-total header row.
 */
import { searchTerm } from '@/lib/searchTerm'
import React, { useState, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { CreditCard, X } from 'lucide-react'
import { AnimatePresence } from 'framer-motion'
import { TokenMenu } from '@/components/ui/TokenMenu'
import { SearchField } from '@/components/ui/SearchField'
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
  /** Filter chip selected on open (e.g. 'refunded' from the Overview tile) */
  initialFilter?: 'all' | 'received' | 'to_settle' | 'refunded'
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
          {payment.blocked && <span className="shrink-0 text-[10px] font-semibold rounded-full px-1.5 py-px bg-danger/10 text-danger">Blocked sender</span>}
          {!payment.blocked && payment.late && <span className="shrink-0 text-[10px] font-semibold rounded-full px-1.5 py-px bg-warning/10 text-warning">Paid late</span>}
          {payment.partlyRefunded && <span className="shrink-0 text-[10px] font-semibold rounded-full px-1.5 py-px bg-danger/10 text-danger">Partly refunded {payment.partlyRefunded}</span>}
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

// Activity-style filter menu under the search box's Filter chip: status only
// (the list is already grouped by day). The app's dropdown (TokenMenu),
// portalled over the page at the chip's spot like Activity's filter.
function FilterMenu({ anchor, status, onStatus, onClose }: {
  anchor: HTMLElement | null; status: Filter; onStatus: (id: Filter) => void; onClose: () => void
}) {
  const r = anchor?.getBoundingClientRect()
  if (!r) return null
  const row = (on: boolean, label: string, onClick: () => void) => (
    <button key={label} type="button" role="menuitemradio" aria-checked={on} onClick={onClick}
      className="flex items-center rounded-full active:opacity-70 transition-opacity text-left"
      style={{ height: 38, flexShrink: 0, padding: '0 14px', background: on ? 'var(--brand)' : 'transparent', border: 'none', cursor: 'pointer' }}>
      <span className="text-[15px] font-bold" style={{ color: on ? '#fff' : 'var(--text-primary)', whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  )
  return createPortal(
    <div style={{ position: 'fixed', top: r.top, left: r.left, width: r.width, height: r.height, zIndex: 60 }}>
      <TokenMenu width={210} ariaLabel="Filter payments" onClose={onClose}>
        {FILTERS.map(f => row(status === f.id, f.label, () => { onStatus(f.id); onClose() }))}
      </TokenMenu>
    </div>,
    document.body,
  )
}

export function PaymentsView({ loading, payments, onPayment, onExport, initialFilter = 'all' }: PaymentsViewProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>(initialFilter)
  const [menu, setMenu] = useState(false)
  const chipRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = searchTerm(query)
    const qNum = q.replace(/^[#$]/, '')
    return payments.filter((p) => {
      const matchFilter = filter === 'all' || p.status === filter
      const matchQuery =
        !q ||
        p.from.toLowerCase().includes(q) ||
        (p.wallet?.toLowerCase().includes(q) ?? false) ||
        p.chainLabel.toLowerCase().includes(q) ||
        (p.order?.toLowerCase().includes(q) ?? false) ||
        (!!qNum && p.amount.replace(/[$,]/g, '').startsWith(qNum))
      return matchFilter && matchQuery
    })
  }, [payments, query, filter])

  const groups = useMemo(() => groupByDay(filtered), [filtered])

  return (
    <div className="flex flex-col gap-4 pb-8">
      {/* Search with the Filter chip (date + status), like Activity */}
      <div className="mx-5 mt-2 flex items-center gap-2">
        <div className="flex-1 min-w-0">
          {(() => {
            const on = filter !== 'all'
            const label = on ? FILTERS.find(f => f.id === filter)?.label ?? 'Filter' : 'Filter'
            return (
              <SearchField value={query} onChange={setQuery} ariaLabel="Search payments"
                placeholder={['Search name, wallet or order', 'Name, wallet, order', 'Search']}
                trailing={
                  <div ref={chipRef} className="flex-shrink-0 flex items-center rounded-full max-w-[150px]"
                    style={{ height: 34, background: on ? 'var(--brand)' : 'color-mix(in srgb, var(--text-primary) 7%, transparent)', color: on ? '#fff' : 'var(--text-primary)' }}>
                    <button type="button" onClick={() => setMenu(m => !m)} aria-label={`Filter: ${label}`} aria-expanded={menu}
                      className="h-full min-w-0 flex items-center gap-1.5 active:opacity-70"
                      style={{ padding: on ? '0 4px 0 12px' : '0 13px 0 12px', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" className="shrink-0">
                        <path d="M4 6h16M4 12h11M4 18h6" />
                      </svg>
                      <span className="truncate">{label}</span>
                    </button>
                    {on && (
                      <button type="button" aria-label="Clear filter" onClick={() => setFilter('all')}
                        className="h-full flex items-center active:opacity-70"
                        style={{ padding: '0 11px 0 4px', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', opacity: 0.85 }}>
                        <X className="w-3.5 h-3.5" strokeWidth={2.6} />
                      </button>
                    )}
                  </div>
                } />
            )
          })()}
        </div>
        {onExport && <ExportButton onClick={onExport} label="CSV" />}
      </div>
      <AnimatePresence>
        {menu && <FilterMenu key="f" anchor={chipRef.current} status={filter} onStatus={setFilter} onClose={() => setMenu(false)} />}
      </AnimatePresence>

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
