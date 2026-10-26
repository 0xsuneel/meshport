/**
 * AutoSettleCard — "Auto-settle reminder" schedule card.
 * SettleDueSheet — "Time to settle $X" bottom sheet.
 */
import React from 'react'
import { Bell } from 'lucide-react'
import { Sheet, ChainLogo } from './primitives'

export type AutoSettleSchedule = 'off' | '6h' | 'daily'

export interface AutoSettleCardProps {
  schedule: AutoSettleSchedule
  time: string           // "21:00" — used when schedule === 'daily'
  onSchedule: (s: AutoSettleSchedule) => void
  onTime: (t: string) => void
  nextLabel?: string     // "Next reminder 9:00 PM"
}

const SCHEDULES: { id: AutoSettleSchedule; label: string }[] = [
  { id: 'off',   label: 'Off' },
  { id: '6h',    label: 'Every 6 h' },
  { id: 'daily', label: 'Daily at…' },
]

export function AutoSettleCard({
  schedule, time, onSchedule, onTime, nextLabel,
}: AutoSettleCardProps) {
  return (
    <div className="bg-card border border-border rounded-3xl p-5 flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center justify-center size-9 rounded-xl bg-brand/10 text-brand-text">
          <Bell className="size-4.5" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-text-primary">Auto-settle reminder</p>
          <p className="text-xs text-text-muted">Get notified when funds are waiting</p>
        </div>
      </div>

      {/* Segmented control */}
      <div className="flex gap-1.5 bg-bg rounded-2xl p-1">
        {SCHEDULES.map(s => (
          <button
            key={s.id}
            type="button"
            onClick={() => onSchedule(s.id)}
            className={[
              'flex-1 h-9 rounded-xl text-sm font-medium transition',
              schedule === s.id
                ? 'bg-brand text-white shadow-sm'
                : 'text-text-secondary hover:text-text-primary',
            ].join(' ')}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Time picker when daily */}
      {schedule === 'daily' && (
        <div className="flex items-center gap-3">
          <label className="text-sm text-text-secondary flex-1">Remind me at</label>
          <input
            type="time"
            value={time}
            onChange={e => onTime(e.target.value)}
            className="h-10 px-3 rounded-xl bg-bg border border-border text-text-primary text-sm ![font-size:max(var(--fs-field,0px),0.875rem)] tabular-nums focus:outline-none focus:ring-2 focus:ring-brand/40"
          />
        </div>
      )}

      {nextLabel && schedule !== 'off' && (
        <p className="text-xs text-text-muted">{nextLabel}</p>
      )}
    </div>
  )
}

// ─── SettleDueSheet ───────────────────────────────────────────────────────────

export interface SettleDueChain { label: string; logo: string }

export interface SettleDueSheetProps {
  open: boolean
  amount: string
  chains: SettleDueChain[]
  onSettle: () => void
  onLater: () => void
}

export function SettleDueSheet({ open, amount, chains, onSettle, onLater }: SettleDueSheetProps) {
  return (
    <Sheet open={open} onClose={onLater}>
      <p className="text-base font-semibold text-text-primary mb-4">Time to settle</p>
      {/* Chain logo stack */}
      <div className="flex items-center gap-2 mb-2">
        <div className="flex -space-x-2">
          {chains.slice(0, 4).map((c, i) => (
            <span key={i} className="ring-2 ring-surface rounded-full">
              <ChainLogo src={c.logo} label={c.label} size={28} />
            </span>
          ))}
        </div>
        <span className="text-sm text-text-secondary">
          {chains.map(c => c.label).join(', ')}
        </span>
      </div>

      <p className="text-4xl font-bold tabular-nums text-text-primary mb-1">{amount}</p>
      <p className="text-sm text-text-muted mb-8">ready to move to your Arc balance</p>

      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={onSettle}
          className="w-full h-13 rounded-2xl bg-brand text-white font-semibold text-base"
        >
          Settle now
        </button>
        <button
          type="button"
          onClick={onLater}
          className="w-full h-12 rounded-2xl text-text-secondary text-sm font-medium hover:bg-border/20 transition-colors"
        >
          Later
        </button>
      </div>
    </Sheet>
  )
}
