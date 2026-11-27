/**
 * SummarySheet — Account → Summaries & cash-out day: the daily sales summary
 * (and the hour it comes), the weekly one (Mondays), and a cash-out day
 * reminder that opens Cash out. Sent by MeshPort's server, in the
 * business's time zone, so they arrive with the app closed.
 */
import { X } from 'lucide-react'
import { Sheet } from './primitives'
import { AlertSwitch, AlertRow } from './VoiceSheet'

export interface SummarySheetValue { daily: boolean; hour: number; weekly: boolean; cashoutDay: number | null; cashoutHour: number }

export interface SummarySheetProps {
  open: boolean
  value: SummarySheetValue
  /** "Asia/Dubai" - shown so the hours aren't a surprise. */
  timeZone: string
  saving?: boolean
  hourLabel: (h: number) => string
  weekdays: readonly string[]
  onChange: (v: SummarySheetValue) => void
  onClose: () => void
}

const SUMMARY_HOURS = [18, 20, 21, 22, 23] as const
const CASHOUT_HOURS = [9, 12, 17] as const

function Chips<T extends string | number | null>({ options, value, label, onPick, disabled }: {
  options: readonly { id: T; label: string }[]; value: T; label: string; onPick: (v: T) => void; disabled?: boolean
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`flex flex-wrap gap-2 px-4 pb-3.5 ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      {options.map(o => (
        <button key={String(o.id)} type="button" role="radio" aria-checked={value === o.id} onClick={() => onPick(o.id)}
          className={`min-h-[34px] px-3.5 rounded-full text-[13px] font-semibold border transition-colors ${value === o.id ? 'bg-brand text-white border-transparent' : 'bg-card text-text-secondary border-border'}`}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function SummarySheet({ open, value: v, timeZone, saving, hourLabel, weekdays, onChange, onClose }: SummarySheetProps) {
  const set = (patch: Partial<SummarySheetValue>) => onChange({ ...v, ...patch })
  return (
    <Sheet open={open} onClose={onClose}>
      <div className="flex flex-col px-4 pb-8 pt-2">
        <div className="flex items-center justify-between mb-1 px-1">
          <p className="text-[19px] font-bold text-text-primary">Summaries & cash-out day</p>
          <button type="button" aria-label="Close" onClick={onClose}
            className="size-9 flex items-center justify-center rounded-xl text-text-muted hover:bg-border/40 transition-colors">
            <X className="size-4.5" />
          </button>
        </div>
        <p className="px-1 mb-3 text-[12.5px] text-text-muted">Sent to this phone, even with MeshPort closed · times in {timeZone.replace(/_/g, ' ')}{saving ? ' · Saving…' : ''}</p>

        <div className="rounded-2xl bg-surface soft-card divide-y divide-border overflow-hidden">
          <div>
            <AlertRow title="Daily summary" sub={`Today's sales and payments, at ${hourLabel(v.hour)}`}>
              <AlertSwitch on={v.daily} label="Daily summary" onClick={() => set({ daily: !v.daily })} />
            </AlertRow>
            <Chips label="Daily summary time" value={v.hour} disabled={!v.daily && !v.weekly}
              options={SUMMARY_HOURS.map(h => ({ id: h, label: hourLabel(h) }))} onPick={h => set({ hour: h })} />
          </div>
          <AlertRow title="Weekly summary" sub={`Every Monday at ${hourLabel(v.hour)} - last week, and how it compares`}>
            <AlertSwitch on={v.weekly} label="Weekly summary" onClick={() => set({ weekly: !v.weekly })} />
          </AlertRow>
        </div>

        <div className="mt-4 rounded-2xl bg-surface soft-card overflow-hidden">
          <div className="px-4 pt-3.5 pb-2.5">
            <p className="text-[15px] font-semibold text-text-primary">Cash-out day</p>
            <p className="text-[13px] text-text-muted mt-0.5">A reminder that opens Cash out - you approve the payout yourself</p>
          </div>
          <Chips label="Cash-out day" value={v.cashoutDay}
            options={[{ id: null, label: 'Off' }, ...[1, 2, 3, 4, 5, 6, 0].map(d => ({ id: d, label: weekdays[d] }))]}
            onPick={d => set({ cashoutDay: d })} />
          {v.cashoutDay !== null && (
            <Chips label="Cash-out reminder time" value={v.cashoutHour}
              options={CASHOUT_HOURS.map(h => ({ id: h, label: hourLabel(h) }))} onPick={h => set({ cashoutHour: h })} />
          )}
        </div>
      </div>
    </Sheet>
  )
}
