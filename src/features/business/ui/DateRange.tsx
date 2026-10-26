/**
 * DateRangeBar — horizontally scrolling date-range chip strip.
 * DateRangeSheet — bottom sheet with two date inputs + presets.
 */
import React from 'react'
import { Calendar } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sheet } from './primitives'

export type DateRangeValue = 'today' | 'yesterday' | 'week' | 'month' | 'custom'

export interface DateRangeBarProps {
  value: DateRangeValue
  customLabel?: string
  onChange: (v: DateRangeValue) => void
  onCustom: () => void
}

const CHIPS: { id: DateRangeValue; label: string }[] = [
  { id: 'today',     label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week',      label: 'Last 7 days' },
  { id: 'month',     label: 'This month' },
]

export function DateRangeBar({ value, customLabel, onChange, onCustom }: DateRangeBarProps) {
  return (
    <div className="flex gap-2 overflow-x-auto no-scrollbar px-5 py-2">
      {CHIPS.map(c => (
        <button
          key={c.id}
          type="button"
          onClick={() => onChange(c.id)}
          className={[
            'shrink-0 h-9 px-4 rounded-full text-sm font-medium transition',
            value === c.id
              ? 'bg-brand text-white'
              : 'bg-card border border-border text-text-secondary hover:border-brand/40',
          ].join(' ')}
        >
          {c.label}
        </button>
      ))}

      {/* Custom chip */}
      <button
        type="button"
        onClick={onCustom}
        className={[
          'shrink-0 h-9 px-4 rounded-full text-sm font-medium flex items-center gap-1.5 transition',
          value === 'custom'
            ? 'bg-brand text-white'
            : 'bg-card border border-border text-text-secondary hover:border-brand/40',
        ].join(' ')}
      >
        <Calendar className="size-3.5" />
        {value === 'custom' && customLabel ? customLabel : 'Custom'}
      </button>
    </div>
  )
}

// ─── DateRangeSheet ───────────────────────────────────────────────────────────

export interface DateRangePreset { id: string; label: string }

export interface DateRangeSheetProps {
  open: boolean
  from: string   // yyyy-mm-dd
  to: string
  onFrom: (v: string) => void
  onTo: (v: string) => void
  presets: DateRangePreset[]
  onPreset: (id: string) => void
  onApply: () => void
  onClose: () => void
}

export function DateRangeSheet({
  open, from, to, onFrom, onTo, presets, onPreset, onApply, onClose,
}: DateRangeSheetProps) {
  return (
    <Sheet open={open} onClose={onClose}>
      <p className="text-base font-semibold text-text-primary mb-4">Custom range</p>
      {/* Preset chips */}
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-5">
          {presets.map(p => (
            <button
              key={p.id}
              type="button"
              onClick={() => onPreset(p.id)}
              className="h-8 px-3 rounded-full text-sm bg-card border border-border text-text-secondary hover:border-brand/40 transition"
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      {/* Date inputs */}
      <div className="flex gap-3 mb-6">
        <label className="flex-1 flex flex-col gap-1">
          <span className="text-xs text-text-muted font-medium">From</span>
          <input
            type="date"
            value={from}
            onChange={e => onFrom(e.target.value)}
            className="h-12 px-3 rounded-2xl bg-card border border-border text-text-primary text-sm ![font-size:max(var(--fs-field,0px),0.875rem)] focus:outline-none focus:ring-2 focus:ring-brand/40"
          />
        </label>
        <label className="flex-1 flex flex-col gap-1">
          <span className="text-xs text-text-muted font-medium">To</span>
          <input
            type="date"
            value={to}
            onChange={e => onTo(e.target.value)}
            className="h-12 px-3 rounded-2xl bg-card border border-border text-text-primary text-sm ![font-size:max(var(--fs-field,0px),0.875rem)] focus:outline-none focus:ring-2 focus:ring-brand/40"
          />
        </label>
      </div>

      <AnimatePresence>
        {from && to && (
          <motion.button
            key="apply"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            type="button"
            onClick={onApply}
            className="w-full h-13 rounded-2xl bg-brand text-white font-semibold text-base"
          >
            Apply
          </motion.button>
        )}
      </AnimatePresence>
    </Sheet>
  )
}

// ─── PeriodSheet ──────────────────────────────────────────────────────────────
// The period picker behind the Overview card's period chip.

export interface PeriodSheetProps {
  open: boolean
  value: DateRangeValue
  customLabel?: string
  onPick: (id: DateRangeValue) => void
  onCustom: () => void
  onClose: () => void
}

export function PeriodSheet({ open, value, customLabel, onPick, onCustom, onClose }: PeriodSheetProps) {
  const rows = [...CHIPS.map(c => ({ ...c, onClick: () => onPick(c.id) })),
    { id: 'custom' as DateRangeValue, label: value === 'custom' && customLabel ? customLabel : 'Custom range…', onClick: onCustom }]
  return (
    <Sheet open={open} onClose={onClose}>
      <p className="text-base font-semibold text-text-primary mb-3">Show collection for</p>
      <div className="flex flex-col">
        {rows.map(r => (
          <button key={r.id} type="button" onClick={r.onClick}
            className="flex items-center justify-between min-h-[52px] px-1 border-b border-border last:border-0 text-left">
            <span className={`text-[15px] ${value === r.id ? 'font-semibold text-text-primary' : 'text-text-secondary'}`}>{r.label}</span>
            {value === r.id && <span className="size-2.5 rounded-full bg-brand" aria-label="Selected" />}
          </button>
        ))}
      </div>
    </Sheet>
  )
}
