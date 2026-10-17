/**
 * TrendChip — compact pill showing percentage change vs yesterday.
 * null pct → muted "No sales <compare>" state.
 */
import React from 'react'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'

export interface TrendChipProps {
  pct: number | null
  /** What it's compared with, e.g. "yesterday", "previous 7 days" */
  compare?: string
  /** On the brand-colored Overview card: plain light text, nothing when there's no comparison */
  tone?: 'default' | 'onBrand'
}

export function TrendChip({ pct, compare = 'yesterday', tone = 'default' }: TrendChipProps) {
  if (tone === 'onBrand') {
    if (pct === null) return null
    const up = pct >= 0
    return (
      <span className="inline-flex items-center gap-1 text-[13px] font-semibold tabular-nums text-white">
        {up ? <TrendingUp className="size-3.5 shrink-0" /> : <TrendingDown className="size-3.5 shrink-0" />}
        {up ? '+' : ''}{pct.toFixed(1)}% vs {compare}
      </span>
    )
  }
  if (pct === null) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-border/40 px-2.5 py-1 text-[11px] font-medium text-text-muted">
        <Minus className="size-3 shrink-0" />
        No sales {compare}
      </span>
    )
  }

  const up = pct >= 0
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold tabular-nums ${
        up ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'
      }`}
    >
      {up
        ? <TrendingUp  className="size-3 shrink-0" />
        : <TrendingDown className="size-3 shrink-0" />}
      {up ? '+' : ''}{pct.toFixed(1)}% vs {compare}
    </span>
  )
}
