/**
 * ArcBalanceCard — "Available on Arc" balance tile.
 * SettlementsSummary — two-column wrapper for Arc balance + waiting-to-settle hero.
 */
import React, { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'

export interface ArcBalanceCardProps {
  amount: string
  hidden?: boolean
  onToggleHidden?: () => void
  note?: string
}

export function ArcBalanceCard({ amount, hidden, onToggleHidden, note }: ArcBalanceCardProps) {
  return (
    <div className="flex-1 bg-card border border-border/50 rounded-2xl p-4 flex flex-col gap-1.5 min-w-0">
      <span className="text-xs text-text-muted font-medium uppercase tracking-wide">
        Available on Arc
      </span>
      <div className="flex items-center gap-2">
        <span className="text-xl font-bold tabular-nums text-text-primary">
          {hidden ? '••••••' : amount}
        </span>
        {onToggleHidden && (
          <button
            type="button"
            aria-label={hidden ? 'Show balance' : 'Hide balance'}
            onClick={onToggleHidden}
            className="text-text-muted hover:text-text-secondary transition-colors"
          >
            {hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        )}
      </div>
      {note && <p className="text-xs text-text-muted leading-snug">{note}</p>}
    </div>
  )
}

// ─── SettlementsSummary ───────────────────────────────────────────────────────

export interface SettlementsSummaryProps {
  arc: React.ReactNode
  waiting: React.ReactNode
}

export function SettlementsSummary({ arc, waiting }: SettlementsSummaryProps) {
  return (
    <div className="flex gap-3 px-5">
      {arc}
      {waiting}
    </div>
  )
}

// Keep a demo wrapper that uses internal state so App.tsx doesn't need to manage hidden
export function ArcBalanceCardDemo({ amount, note }: { amount: string; note?: string }) {
  const [hidden, setHidden] = useState(false)
  return (
    <ArcBalanceCard
      amount={amount}
      hidden={hidden}
      onToggleHidden={() => setHidden(h => !h)}
      note={note}
    />
  )
}
