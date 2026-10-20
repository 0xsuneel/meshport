/**
 * HubView — the owner's Business home: the period's sales with pending orders
 * and the Arc balance, four feature tiles (Collect payment, Manage orders,
 * Manage money, Business tools) each with what needs attention, and the
 * latest verified payments.
 */
import React from 'react'
import { ChevronDown, CreditCard, QrCode, ShoppingBag, Wallet, Settings2, Lock } from 'lucide-react'
import type { Payment, ReactNode } from './types'
import { Skeleton } from './primitives'
import { PaymentRow } from './OverviewView'
import { bizTerms, type BizTerms } from '@/lib/businessCategories'

export type HubTone = 'neutral' | 'brand' | 'warning'
export interface HubTile { badge: string; tone?: HubTone; onClick: () => void }

export interface HubViewProps {
  loading: boolean
  banner?: ReactNode
  periodLabel: string
  onPeriod?: () => void
  sales: { total: string; trend?: ReactNode }
  /** Open + partly paid orders; null while loading */
  pending: { count: number; due: string } | null
  available: string
  /** The label beside `available` (default "Available" - the wallet). */
  availableLabel?: string
  onPending: () => void
  onAvailable: () => void
  collect: HubTile
  orders: HubTile
  money: HubTile
  tools: HubTile
  recent: Payment[]
  onSeeAll: () => void
  onPayment: (p: Payment) => void
  /** Words for the business's category (Orders / Invoices, Customers / Clients) */
  terms?: BizTerms
}

const TONE: Record<HubTone, string> = {
  neutral: 'bg-surface text-text-secondary',
  brand: 'bg-brand/10 text-brand-text',
  warning: 'bg-warning/15 text-warning',
}

function Tile({ icon: Icon, title, sub, tile }: { icon: React.ElementType; title: string; sub: string; tile: HubTile }) {
  return (
    <button type="button" onClick={tile.onClick} aria-label={`${title}: ${tile.badge}`}
      className="flex flex-col items-start gap-1 min-h-[72px] p-2.5 rounded-2xl bg-card border border-border text-left active:scale-[0.98] transition-transform">
      <span className="inline-flex items-center justify-center size-[28px] rounded-xl bg-brand/10 text-brand-text"><Icon className="size-[15px]" /></span>
      <span className="flex flex-col gap-0.5">
        <span className="text-[15px] font-semibold text-text-primary leading-tight">{title}</span>
        <span className="text-xs text-text-muted leading-snug">{sub}</span>
      </span>
      <span className={`mt-auto max-w-full truncate rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE[tile.tone ?? 'neutral']}`}>{tile.badge}</span>
    </button>
  )
}

export function HubView({
  loading, banner, periodLabel, onPeriod, sales, pending, available, availableLabel = 'Available', onPending, onAvailable,
  collect, orders, money, tools, recent, onSeeAll, onPayment, terms = bizTerms(null),
}: HubViewProps) {
  return (
    <div className="flex flex-col gap-2.5 pb-6">
      {banner}

      {/* Sales · pending orders · available balance */}
      <div className="mx-5">
        <div className="rounded-2xl bg-card border border-border p-4 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] text-text-muted">{periodLabel === 'Today' ? "Today's sales" : 'Sales'}</p>
            {onPeriod && (
              <button type="button" onClick={onPeriod} aria-label="Change period"
                className="inline-flex items-center gap-1 min-h-[28px] px-2.5 rounded-full bg-surface border border-border text-xs font-semibold text-text-secondary active:bg-border/30">
                {periodLabel} <ChevronDown className="size-3.5" />
              </button>
            )}
          </div>
          {loading ? <Skeleton className="h-9 w-40 rounded-xl" /> : (
            <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
              <p className="text-[34px] font-bold tabular-nums leading-none tracking-tight text-text-primary">{sales.total}</p>
              {sales.trend}
            </div>
          )}
          {/* One compact bottom row, like the home balance card's bottom line. */}
          <div className="flex items-center justify-between gap-3 mt-0.5 pt-2.5 border-t border-border">
            <button type="button" onClick={onPending} className="flex items-baseline gap-1.5 min-w-0 text-left active:opacity-70">
              <span className="text-xs text-text-muted shrink-0">Pending</span>
              {pending ? <span className="text-sm font-semibold text-text-primary tabular-nums truncate">{pending.count} · {pending.due}</span> : <Skeleton className="h-4 w-16" />}
            </button>
            <button type="button" onClick={onAvailable} className="flex items-baseline gap-1.5 min-w-0 text-left active:opacity-70">
              <span className="text-xs text-text-muted shrink-0">{availableLabel}</span>
              <span className="text-sm font-semibold text-text-primary tabular-nums truncate">{available}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Four feature areas */}
      <div className="mx-5">
        <div className="grid grid-cols-2 gap-2">
          <Tile icon={QrCode} title="Collect payment" sub="Shop QR · Request · Bill" tile={collect} />
          <Tile icon={ShoppingBag} title={`Manage ${terms.orders.toLowerCase()}`} sub={`Status · ${terms.customer} · Receipt`} tile={orders} />
          <Tile icon={Wallet} title="Manage money" sub="Arc balance · Other chains · Settle" tile={money} />
          <Tile icon={Settings2} title="Business tools" sub={`${terms.stores} · Staff · Reports · Settings`} tile={tools} />
        </div>
      </div>

      {/* Latest verified payments */}
      <div className="mx-5">
        <div className="rounded-2xl bg-card border border-border overflow-hidden">
          <div className="flex items-center justify-between px-3.5 pt-2.5 pb-1">
            <p className="text-[15px] font-semibold text-text-primary">Verified payments</p>
            {recent.length > 0 && (
              <button type="button" onClick={onSeeAll} className="min-h-[32px] text-[13px] font-semibold text-brand-text active:opacity-70">See all</button>
            )}
          </div>
          {loading ? (
            <div className="flex flex-col gap-2.5 px-3.5 pt-1.5 pb-3">
              {[0, 1, 2].map(i => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="size-9 rounded-full" />
                  <div className="flex-1"><Skeleton className="h-3.5 w-32 mb-1.5" /><Skeleton className="h-3 w-20" /></div>
                  <Skeleton className="h-4 w-14" />
                </div>
              ))}
            </div>
          ) : recent.length === 0 ? (
            <div className="flex flex-col items-center text-center px-6 pt-2 pb-5">
              <span className="inline-flex items-center justify-center size-10 rounded-2xl bg-surface border border-border mb-2"><CreditCard className="size-[18px] text-text-muted" /></span>
              <p className="text-sm font-medium text-text-secondary">No payments yet</p>
              <p className="text-xs text-text-muted mt-1">Open Collect payment to show your QR</p>
            </div>
          ) : (
            <div className="divide-y divide-border">{recent.slice(0, 4).map(p => <PaymentRow key={p.id} payment={p} onClick={onPayment} />)}</div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Business home before approval: only the apply banner and what approval
 *  turns on - the business tools stay hidden until MeshPort approves it. */
export function LockedHubView({ banner, terms = bizTerms(null) }: { banner: ReactNode; terms?: BizTerms }) {
  const rows: Array<[React.ElementType, string, string]> = [
    [QrCode, 'Collect payment', 'Shop QR, requests and bills'],
    [ShoppingBag, `Manage ${terms.orders.toLowerCase()}`, `Open, paid and cancelled ${terms.orders.toLowerCase()}`],
    [Wallet, 'Manage money', 'Arc balance, other chains and settle'],
    [Settings2, 'Business tools', `${terms.stores}, staff, reports and payouts`],
  ]
  return (
    <div className="flex flex-col gap-3 pb-8">
      {banner}
      <div className="mx-5">
        <div className="rounded-2xl bg-card border border-border overflow-hidden">
          <p className="px-4 pt-4 pb-2 text-[13px] font-semibold text-text-muted">Turns on after approval</p>
          <div className="divide-y divide-border">
            {rows.map(([Icon, title, sub]) => (
              <div key={title} className="flex items-center gap-3 px-4 py-3">
                <span className="inline-flex items-center justify-center size-9 rounded-xl bg-surface text-text-muted shrink-0"><Icon className="size-[18px]" /></span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[15px] font-semibold text-text-primary">{title}</span>
                  <span className="block text-xs text-text-muted truncate">{sub}</span>
                </span>
                <Lock className="size-4 text-text-muted shrink-0" aria-label="Locked" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
