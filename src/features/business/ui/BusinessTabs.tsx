/**
 * BusinessTabs — 3-tab navigation: Overview, Payments, Settlements.
 * The Settlements tab carries an optional count badge.
 */
import React from 'react'
import { motion } from 'framer-motion'
import { Badge } from './primitives'
import { springs } from './types'

export type BusinessTab = 'overview' | 'payments' | 'settlements'

export interface BusinessTabsProps {
  tab: BusinessTab
  onTab: (t: BusinessTab) => void
  /** Badge count on the Settlements tab — pending settlements awaiting action. */
  settleCount: number
}

const TABS: { id: BusinessTab; label: string }[] = [
  { id: 'overview',     label: 'Overview' },
  { id: 'payments',     label: 'Payments' },
  { id: 'settlements',  label: 'Settlements' },
]

export function BusinessTabs({ tab, onTab, settleCount }: BusinessTabsProps) {
  return (
    <nav
      role="tablist"
      aria-label="Business sections"
      className="relative flex gap-1 mx-5 mt-1 p-1 rounded-2xl bg-surface border border-border"
    >
      {TABS.map(({ id, label }) => {
        const active = id === tab
        return (
          <button
            key={id}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onTab(id)}
            className={`relative flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-medium rounded-xl transition-colors z-10 min-h-[44px] ${
              active ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {/* sliding background pill */}
            {active && (
              <motion.span
                layoutId="tab-pill"
                className="absolute inset-0 rounded-xl bg-card shadow-sm border border-border"
                transition={springs.snappy}
              />
            )}
            <span className="relative z-10">{label}</span>
            {id === 'settlements' && settleCount > 0 && (
              <Badge count={settleCount} className="relative z-10" />
            )}
          </button>
        )
      })}
    </nav>
  )
}
