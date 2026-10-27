/**
 * HourChart — compact 24-bar intra-day chart.
 * Only every 4th x-axis label is shown to avoid crowding.
 */
import React from 'react'
import { motion } from 'framer-motion'

export interface HourBar {
  label: string   // e.g. "8 AM"
  value: number
  display: string // e.g. "$120"
}

export interface HourChartProps {
  title: string
  sub: string
  bars: HourBar[]  // 24 items
  peak?: string    // e.g. "Busiest: 6 PM"
}

export function HourChart({ title, sub, bars, peak }: HourChartProps) {
  const max = Math.max(...bars.map((b) => b.value), 1)

  return (
    <div className="rounded-3xl bg-card soft-card p-5">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <p className="text-sm font-semibold text-text-primary">{title}</p>
          <p className="text-xs text-text-muted mt-0.5">{sub}</p>
        </div>
        {peak && (
          <span className="text-[11px] font-medium text-text-muted bg-border/40 rounded-xl px-2.5 py-1 shrink-0 ml-2">
            {peak}
          </span>
        )}
      </div>

      {/* Bars */}
      <div className="flex items-end gap-[3px] h-[56px]">
        {bars.map((bar, i) => {
          const pct = Math.max(3, (bar.value / max) * 100)
          // Highlight bars with above-average value
          const avg = bars.reduce((s, b) => s + b.value, 0) / bars.length
          const hot = bar.value > avg * 1.3
          return (
            <motion.div
              key={i}
              className={`flex-1 rounded-t-[3px] ${hot ? 'bg-brand' : 'bg-brand/25'}`}
              initial={{ height: 0, originY: 1 }}
              animate={{ height: `${pct}%` }}
              transition={{ duration: 0.4, ease: 'easeOut', delay: i * 0.01 }}
              title={`${bar.label}: ${bar.display}`}
              style={{ alignSelf: 'flex-end' }}
            />
          )
        })}
      </div>

      {/* X-axis labels: every 4th */}
      <div className="flex mt-1.5">
        {bars.map((bar, i) => (
          <div key={i} className="flex-1">
            {i % 4 === 0 && (
              <span className="block text-[11px] text-text-muted text-center leading-none truncate">
                {bar.label}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
