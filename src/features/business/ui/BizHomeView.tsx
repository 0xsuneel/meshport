/**
 * BizHomeView — a business account's Home (27 Nov): the business app's first
 * screen, like PhonePe Business / Paytm for Business / Square. Today's sales
 * (payments, average, open orders), the ways to get paid one tap away, the
 * money (available, arriving from other networks, cash out, pay staff), what
 * needs attention, and the latest payments.
 */
import React from 'react'
import { ChevronDown, CreditCard, QrCode, BadgeDollarSign, ReceiptText, Link2, ShoppingBag, Users, ChevronRight } from 'lucide-react'
import type { Payment, ReactNode } from './types'
import { Skeleton } from './primitives'
import { PaymentRow } from './OverviewView'

export interface BizHomeAttention { id: string; label: string; onClick: () => void; tone?: 'warning' | 'brand' }

export interface BizHomeViewProps {
  loading: boolean
  banner?: ReactNode
  periodLabel: string
  onPeriod?: () => void
  total: string
  trend?: ReactNode
  stats: { count: number; average: string; openOrders: number | null }
  onOpenOrders: () => void
  onQr: () => void
  onCharge: () => void
  onBill: () => void
  onPayLink: () => void
  available: string
  availableLabel?: string
  /** "$42.10" waiting on other networks, or null. */
  arriving: string | null
  arrivingBusy?: boolean
  onMove: () => void
  onMoney: () => void
  onCashOut: () => void
  onPayStaff: () => void
  attention: BizHomeAttention[]
  recent: Payment[]
  onSeeAll: () => void
  onPayment: (p: Payment) => void
  hideRecent?: boolean
}

const card = 'rounded-[20px] bg-card border border-border'

function Quick({ icon: Icon, label, tint, onClick }: { icon: React.ElementType; label: string; tint: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`${card} flex flex-col items-center gap-1.5 py-2.5 active:scale-[0.97] transition-transform`}>
      <span className="inline-flex items-center justify-center size-[38px] rounded-xl" style={{ background: `var(--tile-${tint})`, color: `var(--tile-${tint}-ink)` }}>
        <Icon className="size-[19px]" />
      </span>
      <span className="text-[11.5px] font-semibold text-text-primary">{label}</span>
    </button>
  )
}

export function BizHomeView(p: BizHomeViewProps) {
  return (
    <div className="relative flex flex-col gap-3 pb-6">
      {p.banner}

      {/* Today's sales */}
      <div className="mx-5">
        <div className={`${card} p-4`} style={{ boxShadow: 'var(--glass-card)' }}>
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] font-semibold text-text-muted">{p.periodLabel === 'Today' ? "Today's sales" : `Sales · ${p.periodLabel}`}</p>
            {p.onPeriod && (
              <button type="button" onClick={p.onPeriod} aria-label="Change period"
                className="inline-flex items-center gap-1 min-h-[28px] px-2.5 rounded-full bg-surface border border-border text-xs font-semibold text-text-secondary active:bg-border/30">
                {p.periodLabel} <ChevronDown className="size-3.5" />
              </button>
            )}
          </div>
          {p.loading ? <Skeleton className="h-10 w-44 rounded-xl mt-2" /> : (
            <div className="flex flex-wrap items-end gap-x-3 gap-y-1 mt-1.5">
              <p className="text-[34px] font-bold tabular-nums leading-none tracking-tight text-text-primary">{p.total}</p>
              {p.trend}
            </div>
          )}
          <div className="grid grid-cols-3 mt-3.5 pt-3 border-t border-border text-center">
            <div><p className="text-[15px] font-bold tabular-nums text-text-primary">{p.loading ? '–' : p.stats.count}</p><p className="text-[11px] text-text-muted">Payments</p></div>
            <div><p className="text-[15px] font-bold tabular-nums text-text-primary">{p.loading ? '–' : p.stats.average}</p><p className="text-[11px] text-text-muted">Average</p></div>
            <button type="button" onClick={p.onOpenOrders} className="active:opacity-70">
              <p className="text-[15px] font-bold tabular-nums text-text-primary">{p.stats.openOrders ?? '–'}</p><p className="text-[11px] text-text-muted">Open orders</p>
            </button>
          </div>
        </div>
      </div>

      {/* Ways to get paid */}
      <div className="mx-5 grid grid-cols-4 gap-2">
        <Quick icon={QrCode} label="Show QR" tint="mint" onClick={p.onQr} />
        <Quick icon={BadgeDollarSign} label="Charge" tint="butter" onClick={p.onCharge} />
        <Quick icon={ReceiptText} label="Bill" tint="peach" onClick={p.onBill} />
        <Quick icon={Link2} label="Pay link" tint="mint" onClick={p.onPayLink} />
      </div>

      {/* Money */}
      <div className="mx-5">
        <div className={`${card} p-3.5`}>
          <button type="button" onClick={p.onMoney} className="w-full flex items-center justify-between gap-3 text-left active:opacity-70">
            <span className="text-[13px] font-semibold text-text-muted">{p.availableLabel ?? 'Available'}</span>
            <span className="text-[20px] font-bold tabular-nums text-text-primary">{p.available}</span>
          </button>
          {(p.arriving || p.arrivingBusy) && (
            <button type="button" onClick={p.onMove}
              className="w-full mt-2.5 flex items-center justify-between gap-2 px-3 py-2 rounded-xl text-left text-[12.5px] active:opacity-80"
              style={{ background: 'color-mix(in srgb, var(--brand) 10%, transparent)' }}>
              <span className="text-text-secondary truncate">{p.arriving ? `${p.arriving} arriving from other networks` : 'Checking other networks…'}</span>
              {p.arriving && <span className="shrink-0 font-semibold text-brand-text">Move ›</span>}
            </button>
          )}
          <div className="grid grid-cols-2 gap-2 mt-3">
            <button type="button" onClick={p.onCashOut} className="min-h-[40px] rounded-[14px] bg-brand text-white text-[14px] font-semibold active:opacity-90">Cash out</button>
            <button type="button" onClick={p.onPayStaff} className="min-h-[40px] rounded-[14px] text-text-primary text-[14px] font-semibold active:opacity-80"
              style={{ background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', boxShadow: 'inset 0 0 0 1px var(--border)' }}>Pay staff</button>
          </div>
        </div>
      </div>

      {/* Needs attention - only when there is something */}
      {p.attention.length > 0 && (
        <div className="mx-5">
          <p className="text-[16px] font-bold text-text-primary mb-2 px-0.5">Needs attention</p>
          <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-5 px-5">
            {p.attention.map(a => (
              <button key={a.id} type="button" onClick={a.onClick}
                className={`${card} shrink-0 flex items-center gap-2 px-3 py-2 text-[12.5px] font-semibold active:scale-[0.97] transition-transform`}
                style={{ color: a.tone === 'warning' ? 'var(--warning-text)' : 'var(--text-primary)' }}>
                {a.id === 'orders' ? <ShoppingBag className="size-4" /> : <Users className="size-4" />}
                {a.label}
                <ChevronRight className="size-3.5 opacity-60" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Latest payments */}
      {!p.hideRecent && <div className="mx-5">
        <div className="flex items-center justify-between mb-2 px-0.5">
          <p className="text-[16px] font-bold text-text-primary">Latest payments</p>
          {p.recent.length > 0 && <button type="button" onClick={p.onSeeAll} className="text-[13px] font-semibold text-brand-text active:opacity-70">See all ›</button>}
        </div>
        <div className={`${card} overflow-hidden`}>
          {p.loading ? (
            <div className="flex flex-col gap-2.5 px-3.5 py-3">
              {[0, 1, 2].map(i => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="size-9 rounded-full" />
                  <div className="flex-1"><Skeleton className="h-3.5 w-32 mb-1.5" /><Skeleton className="h-3 w-20" /></div>
                  <Skeleton className="h-4 w-14" />
                </div>
              ))}
            </div>
          ) : p.recent.length === 0 ? (
            <div className="flex flex-col items-center text-center px-6 py-5">
              <span className="inline-flex items-center justify-center size-10 rounded-2xl bg-surface border border-border mb-2"><CreditCard className="size-[18px] text-text-muted" /></span>
              <p className="text-sm font-medium text-text-secondary">No payments yet</p>
              <p className="text-xs text-text-muted mt-1">Show your QR to take your first payment</p>
            </div>
          ) : (
            <div className="divide-y divide-border">{p.recent.slice(0, 5).map(r => <PaymentRow key={r.id} payment={r} onClick={p.onPayment} />)}</div>
          )}
        </div>
      </div>}
    </div>
  )
}
