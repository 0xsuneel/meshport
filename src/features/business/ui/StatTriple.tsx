/**
 * StatTriple — row of exactly three equal stat tiles.
 * Typical use: Average ticket | Waiting to settle | Customers.
 */
import React from 'react'

export interface StatItem {
  label: string
  value: string
  hint?: string
}

export interface StatTripleProps {
  items: [StatItem, StatItem, StatItem]
}

export function StatTriple({ items }: StatTripleProps) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map((item, i) => (
        <div
          key={i}
          className="flex flex-col gap-1 rounded-2xl bg-surface soft-card px-3 py-3.5"
        >
          <span className="text-[11px] font-medium text-text-muted leading-tight">{item.label}</span>
          <span className="display text-lg font-bold tabular-nums text-text-primary leading-tight">
            {item.value}
          </span>
          {item.hint && (
            <span className="text-[11px] text-text-muted leading-tight">{item.hint}</span>
          )}
        </div>
      ))}
    </div>
  )
}
