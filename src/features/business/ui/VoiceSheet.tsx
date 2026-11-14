/**
 * VoiceSheet — Business → Payment alerts: voice alerts on/off, a test that
 * plays the real voice, the smallest payment said out loud, vibrate, the big
 * "Payment received" card, and today's payments. English only (one voice).
 */
import React from 'react'
import { X, Play } from 'lucide-react'
import { motion } from 'framer-motion'
import { Sheet } from './primitives'
import { springs } from './types'

export interface TodayAlert { id: string; who: string; detail: string; amount: string }

export interface VoiceSheetProps {
  open: boolean
  enabled: boolean
  vibrate: boolean
  bigCard: boolean
  /** Payments below this only chime. */
  minAmount: number
  minChoices: readonly number[]
  /** What the test alert says, written out. */
  testLine: string
  /** Today's payments (newest first) and their total. */
  today?: { total: string; list: TodayAlert[] }
  onToggle: () => void
  onVibrate: () => void
  onBigCard: () => void
  onMinAmount: (n: number) => void
  onTest: () => void
  onClose: () => void
}

function Switch({ on, label, onClick, disabled }: { on: boolean; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick} disabled={disabled}
      className={`relative inline-flex items-center h-7 w-12 rounded-full transition-colors shrink-0 disabled:opacity-40 ${on ? 'bg-brand' : 'bg-border'}`}>
      <motion.span className="absolute size-5 rounded-full bg-white shadow" animate={{ x: on ? 22 : 3 }} transition={springs.snappy} />
    </button>
  )
}

function Row({ title, sub, children, dim }: { title: string; sub: string; children: React.ReactNode; dim?: boolean }) {
  return (
    <div className={`flex items-center gap-3 px-4 py-3.5 ${dim ? 'opacity-40 pointer-events-none' : ''}`}>
      <div className="flex-1 min-w-0">
        <p className="text-[15px] font-semibold text-text-primary">{title}</p>
        <p className="text-[13px] text-text-muted mt-0.5">{sub}</p>
      </div>
      {children}
    </div>
  )
}

export function VoiceSheet({
  open, enabled, vibrate, bigCard, minAmount, minChoices, testLine, today,
  onToggle, onVibrate, onBigCard, onMinAmount, onTest, onClose,
}: VoiceSheetProps) {
  return (
    <Sheet open={open} onClose={onClose}>
      <div className="flex flex-col px-4 pb-8 pt-2">
        <div className="flex items-center justify-between mb-3 px-1">
          <p className="text-[19px] font-bold text-text-primary">Payment alerts</p>
          <button type="button" aria-label="Close payment alerts" onClick={onClose}
            className="size-9 flex items-center justify-center rounded-xl text-text-muted hover:bg-border/40 transition-colors">
            <X className="size-4.5" />
          </button>
        </div>

        <div className="rounded-2xl bg-surface soft-card divide-y divide-border overflow-hidden">
          <Row title="Voice alerts" sub="Say each payment out loud">
            <Switch on={enabled} label="Voice alerts" onClick={onToggle} />
          </Row>
          <button type="button" onClick={onTest} disabled={!enabled}
            className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-border/20 disabled:opacity-40">
            <span className="flex items-center justify-center size-10 rounded-full bg-brand text-white shrink-0"><Play className="size-4 ml-0.5" fill="currentColor" /></span>
            <span className="flex-1 min-w-0">
              <span className="block text-[15px] font-semibold text-text-primary">Play a test alert</span>
              <span className="block text-[13px] text-text-muted mt-0.5 text-pretty">&ldquo;{testLine}&rdquo;</span>
            </span>
          </button>
          <Row title="Voice" sub="English · Emma" dim={!enabled}><span /></Row>
          <div className={`px-4 py-3.5 ${enabled ? '' : 'opacity-40 pointer-events-none'}`}>
            <p className="text-[15px] font-semibold text-text-primary">Only say payments above</p>
            <p className="text-[13px] text-text-muted mt-0.5">Smaller ones just chime</p>
            <div className="mt-2.5 flex gap-2" role="radiogroup" aria-label="Smallest payment said out loud">
              {minChoices.map(n => (
                <button key={n} type="button" role="radio" aria-checked={minAmount === n} onClick={() => onMinAmount(n)}
                  className={`flex-1 rounded-xl py-2 text-[13px] font-semibold transition ${minAmount === n ? 'bg-brand text-white' : 'bg-border/40 text-text-secondary'}`}>
                  {n === 0 ? 'Any' : `$${n.toFixed(2)}`}
                </button>
              ))}
            </div>
          </div>
          <Row title="Vibrate too" sub="For when the phone is on silent">
            <Switch on={vibrate} label="Vibrate with alerts" onClick={onVibrate} />
          </Row>
          <Row title="Big alert card" sub="Show it over the app">
            <Switch on={bigCard} label="Big alert card" onClick={onBigCard} />
          </Row>
        </div>

        <p className="text-[12.5px] text-text-muted leading-relaxed px-2 mt-3">
          Alerts speak while MeshPort is open. With the app closed you get a notification, and the payment is said as soon as you open MeshPort again.
        </p>

        {today && (
          <>
            <p className="text-[12px] font-bold text-text-muted tracking-wider uppercase px-2 mt-5 mb-2">Today · {today.total}</p>
            {today.list.length ? (
              <div className="rounded-2xl bg-surface soft-card divide-y divide-border overflow-hidden">
                {today.list.map(t => (
                  <div key={t.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="flex-1 min-w-0">
                      <span className="block text-[15px] font-semibold text-text-primary truncate">{t.who}</span>
                      <span className="block text-[13px] text-text-muted truncate">{t.detail}</span>
                    </span>
                    <span className="text-[15px] font-bold tabular-nums text-success shrink-0">+{t.amount}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-text-muted px-2">No payments yet today.</p>
            )}
          </>
        )}
      </div>
    </Sheet>
  )
}
