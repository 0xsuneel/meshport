/**
 * Insights components: InsightsChart (7-day bar chart) and RankList (top items/customers).
 */
import React from 'react'
import { motion } from 'framer-motion'
import { ChainLogo, Divider } from './primitives'

// ─── InsightsChart ───────────────────────────────────────────────────────────

export interface InsightsBar {
  label: string    // e.g. "Mon"
  value: number    // raw numeric, used for relative height
  display: string  // formatted, e.g. "$48"
}

export interface InsightsChartProps {
  total: string   // e.g. "$4,821.00"
  sub: string     // e.g. "This week · 7 days"
  bars: InsightsBar[]  // exactly 7, last = today
}

export function InsightsChart({ total, sub, bars }: InsightsChartProps) {
  const max = Math.max(...bars.map((b) => b.value), 1)
  const todayIndex = bars.length - 1

  return (
    <div className="rounded-3xl bg-card border border-border p-5">
      {/* Hero total */}
      <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">{sub}</p>
      <p className="display text-3xl font-bold tabular-nums text-text-primary mt-1">{total}</p>

      {/* Bar chart */}
      <div className="mt-5 flex items-end justify-between gap-1.5 h-[80px]">
        {bars.map((bar, i) => {
          const pct = Math.max(4, (bar.value / max) * 100)
          const isToday = i === todayIndex
          return (
            <div key={i} className="flex flex-col items-center gap-1.5 flex-1">
              <div className="relative w-full flex items-end justify-center h-[64px]">
                <motion.div
                  className={`w-full rounded-t-lg ${isToday ? 'bg-brand' : 'bg-brand/25'}`}
                  initial={{ height: 0 }}
                  animate={{ height: `${pct}%` }}
                  transition={{ duration: 0.5, ease: 'easeOut', delay: i * 0.04 }}
                  title={bar.display}
                />
              </div>
              <span
                className={`text-[9px] font-medium ${isToday ? 'text-brand-text font-semibold' : 'text-text-muted'}`}
              >
                {bar.label}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── RankList ────────────────────────────────────────────────────────────────

export interface RankRow {
  id: string
  left: string     // primary label
  sub: string      // secondary label
  right: string    // metric, e.g. "$482" or "24 orders"
  logo?: string    // optional image URL
}

export interface RankListProps {
  title: string
  empty: string
  rows: RankRow[]
}

export function RankList({ title, empty, rows }: RankListProps) {
  return (
    <div className="rounded-2xl bg-surface border border-border overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <p className="text-xs font-semibold text-text-secondary uppercase tracking-wider">{title}</p>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-text-muted text-center py-8">{empty}</p>
      ) : (
        rows.map((row, i) => (
          <React.Fragment key={row.id}>
            {i > 0 && <Divider className="mx-4" />}
            <div className="flex items-center gap-3 px-4 py-3.5">
              {/* Rank number */}
              <span className="text-xs font-bold tabular-nums text-text-muted w-5 shrink-0 text-center">
                {i + 1}
              </span>
              {/* Logo or initial circle */}
              {row.logo ? (
                <ChainLogo src={row.logo} label={row.left} size={32} />
              ) : (
                <span className="inline-flex items-center justify-center size-8 rounded-full bg-brand/10 text-brand-text text-xs font-semibold shrink-0">
                  {row.left[0]?.toUpperCase() ?? '?'}
                </span>
              )}
              {/* Labels */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary truncate">{row.left}</p>
                <p className="text-xs text-text-muted mt-0.5 truncate">{row.sub}</p>
              </div>
              {/* Metric */}
              <span className="text-sm font-semibold tabular-nums text-text-primary shrink-0">
                {row.right}
              </span>
            </div>
          </React.Fragment>
        ))
      )}
    </div>
  )
}
