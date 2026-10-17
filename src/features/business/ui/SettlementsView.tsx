/**
 * SettlementsView — money-movement screen.
 * Hero: "Ready to settle" total + chain stack + one CTA.
 * Below: per-chain balances with proportion bars, then history.
 */
import React from 'react'
import {
  RefreshCw, ArrowDownToLine, CheckCircle2, AlertCircle, Loader2, ChevronRight, Layers,
} from 'lucide-react'
import { motion } from 'framer-motion'
import type { Chain, SettlementHistoryItem } from './types'
import { Skeleton, ChainLogo, Divider, FadeUp } from './primitives'

export interface SettlementsViewProps {
  scanning: boolean
  chains: Chain[]
  total: string      // e.g. "$312.40"
  settle: {
    enabled: boolean
    label: string    // "Settle $312.40 to Arc" | "Next settle in 4h 10m" | "Nothing to settle"
    note: string     // "Uses CCTP. MeshPort pays the gas."
  }
  onSettle: () => void
  onRefresh: () => void
  history: SettlementHistoryItem[]
  onHistory: (id: string) => void
  lastRun?: {
    running: boolean
    onOpen: () => void
  }
}

// ─── Chain proportion bar ────────────────────────────────────────────────────

function ChainBalanceRow({
  chain,
  maxAmount,
}: {
  chain: Chain
  maxAmount: number
}) {
  const amount = parseFloat(chain.balance.replace(/[^0-9.]/g, ''))
  const pct = maxAmount > 0 ? Math.max(4, (amount / maxAmount) * 100) : 4

  return (
    <div className="flex items-center gap-3 py-3">
      <ChainLogo src={chain.logo} label={chain.label} size={36} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-sm font-medium text-text-primary">{chain.label}</span>
          <span className="text-sm font-semibold tabular-nums text-text-primary">{chain.balance}</span>
        </div>
        <div className="h-1.5 rounded-full bg-border/60 overflow-hidden">
          <motion.div
            className="h-full rounded-full bg-brand-text/70"
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.6, ease: 'easeOut', delay: 0.1 }}
          />
        </div>
      </div>
    </div>
  )
}

// ─── History row ─────────────────────────────────────────────────────────────

function HistoryRow({
  item,
  onClick,
}: {
  item: SettlementHistoryItem
  onClick: (id: string) => void
}) {
  const statusInfo = {
    completed:  { Icon: CheckCircle2, color: 'text-success',    label: 'Completed' },
    in_progress:{ Icon: Loader2,      color: 'text-brand-text', label: 'In progress' },
    failed:     { Icon: AlertCircle,  color: 'text-danger',     label: 'Failed' },
  }[item.status]

  return (
    <button
      type="button"
      aria-label={`Settlement ${item.id}`}
      onClick={() => onClick(item.id)}
      className="w-full flex items-center gap-3 py-3.5 px-1 -mx-1 rounded-xl active:bg-border/20 transition-colors"
    >
      <span
        className={`inline-flex items-center justify-center size-9 rounded-2xl ${
          item.status === 'completed'
            ? 'bg-success/10'
            : item.status === 'failed'
            ? 'bg-danger/10'
            : 'bg-brand/10'
        }`}
      >
        <statusInfo.Icon className={`size-4 ${statusInfo.color} ${item.status === 'in_progress' ? 'animate-spin' : ''}`} />
      </span>
      <div className="flex-1 min-w-0 text-left">
        <p className="text-sm font-medium text-text-primary tabular-nums">{item.amount}</p>
        <p className="text-xs text-text-muted mt-0.5 truncate">
          {item.chainLabels.join(', ')} · {new Date(item.when).toLocaleDateString([], { month: 'short', day: 'numeric' })}
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <span className={`text-xs font-medium ${statusInfo.color}`}>{statusInfo.label}</span>
        <ChevronRight className="size-3.5 text-text-muted" />
      </div>
    </button>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

export function SettlementsView({
  scanning,
  chains,
  total,
  settle,
  onSettle,
  onRefresh,
  history,
  onHistory,
  lastRun,
}: SettlementsViewProps) {
  const maxAmount = Math.max(
    ...chains.map((c) => parseFloat(c.balance.replace(/[^0-9.]/g, '')) || 0),
  )

  return (
    <div className="flex flex-col gap-5 pb-8">
      {/* ── Hero card ────────────────────────────────────────────────────── */}
      <FadeUp delay={0.04} className="mx-5">
        <div className="rounded-3xl bg-card border border-border p-5">
          {/* Header */}
          <div className="flex items-start justify-between mb-4">
            <div>
              <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">Ready to settle</p>
              {scanning ? (
                <Skeleton className="mt-2 h-10 w-36" />
              ) : (
                <p className="display mt-1.5 text-4xl font-bold tabular-nums text-text-primary">{total}</p>
              )}
              {/* Chain logo stack */}
              {!scanning && chains.length > 0 && (
                <div className="flex items-center mt-2 -space-x-1.5">
                  {chains.slice(0, 4).map((c) => (
                    <div key={c.id} className="ring-2 ring-card rounded-full">
                      <ChainLogo src={c.logo} label={c.label} size={20} />
                    </div>
                  ))}
                  {chains.length > 4 && (
                    <span className="text-[10px] text-text-muted ml-2">+{chains.length - 4}</span>
                  )}
                </div>
              )}
            </div>

            <button
              type="button"
              aria-label="Refresh balances"
              onClick={onRefresh}
              className={`size-9 flex items-center justify-center rounded-xl text-text-muted hover:bg-border/40 transition-colors ${scanning ? 'opacity-40 pointer-events-none' : ''}`}
            >
              <RefreshCw className={`size-4 ${scanning ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* Primary settle button */}
          <button
            type="button"
            disabled={!settle.enabled}
            onClick={onSettle}
            className="w-full flex items-center justify-center gap-2 rounded-2xl py-4 text-sm font-semibold bg-brand text-white hover:bg-brand/90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ArrowDownToLine className="size-4" />
            {settle.label}
          </button>

          {/* Gas note */}
          <p className="mt-2.5 text-center text-[11px] text-text-muted">{settle.note}</p>
        </div>
      </FadeUp>

      {/* Last run status */}
      {lastRun && (
        <FadeUp delay={0.06} className="mx-5">
          <button
            type="button"
            onClick={lastRun.onOpen}
            className="w-full flex items-center justify-between rounded-2xl bg-surface border border-border px-4 py-3"
          >
            <div className="flex items-center gap-2 text-text-secondary">
              {lastRun.running ? (
                <Loader2 className="size-4 text-brand-text animate-spin" />
              ) : (
                <Layers className="size-4" />
              )}
              <span className="text-xs font-medium">
                {lastRun.running ? 'Settlement in progress' : 'View last settlement'}
              </span>
            </div>
            <ChevronRight className="size-4 text-text-muted" />
          </button>
        </FadeUp>
      )}

      {/* ── Per-chain balances ──────────────────────────────────────────── */}
      <FadeUp delay={0.1} className="mx-5">
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">On each chain</p>
        <div className="rounded-2xl bg-surface border border-border px-4 py-1">
          {scanning ? (
            <div className="flex flex-col gap-4 py-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="size-9 rounded-full" />
                  <div className="flex-1">
                    <Skeleton className="h-3.5 w-28 mb-2" />
                    <Skeleton className="h-1.5 w-full rounded-full" />
                  </div>
                  <Skeleton className="h-4 w-16" />
                </div>
              ))}
            </div>
          ) : chains.length === 0 ? (
            <div className="flex flex-col items-center py-8 text-center">
              <ArrowDownToLine className="size-5 text-text-muted mb-2" />
              <p className="text-sm text-text-secondary font-medium">No balances to settle</p>
              <p className="text-xs text-text-muted mt-0.5">Receive payments on other chains to see them here</p>
            </div>
          ) : (
            chains.map((chain, i) => (
              <React.Fragment key={chain.id}>
                {i > 0 && <Divider />}
                <ChainBalanceRow chain={chain} maxAmount={maxAmount} />
              </React.Fragment>
            ))
          )}
        </div>
      </FadeUp>

      {/* ── Settlement history ──────────────────────────────────────────── */}
      <FadeUp delay={0.14} className="mx-5">
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">Settlement history</p>
        <div className="rounded-2xl bg-surface border border-border px-4 py-1">
          {history.length === 0 ? (
            <div className="flex flex-col items-center py-8 text-center">
              <CheckCircle2 className="size-5 text-text-muted mb-2" />
              <p className="text-sm text-text-secondary font-medium">No settlements yet</p>
              <p className="text-xs text-text-muted mt-0.5">Your settlement history will appear here</p>
            </div>
          ) : (
            history.map((item, i) => (
              <React.Fragment key={item.id}>
                {i > 0 && <Divider />}
                <HistoryRow item={item} onClick={onHistory} />
              </React.Fragment>
            ))
          )}
        </div>
      </FadeUp>
    </div>
  )
}
