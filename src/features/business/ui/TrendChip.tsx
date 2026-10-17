/**
 * TrendChip — compact pill showing percentage change vs yesterday.
 * null pct → muted "No sales yesterday" state.
 */
import React from 'react'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'

export interface TrendChipProps {
  pct: number | null
}

export function TrendChip({ pct }: TrendChipProps) {
  if (pct === null) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-border/40 px-2.5 py-1 text-[11px] font-medium text-text-muted">
        <Minus className="size-3 shrink-0" />
        No sales yesterday
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
      {up ? '+' : ''}{pct.toFixed(1)}% vs yesterday
    </span>
  )
}
