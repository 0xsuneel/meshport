/**
 * SettleProgressSheet — full-height bottom sheet showing per-chain settlement progress.
 * Each chain row has a 4-step stepper: Send → Bridge → Verify → Arrived.
 */
import React from 'react'
import {
  X, CheckCircle2, Loader2, AlertCircle, ArrowRight, ExternalLink,
  Send, Shuffle, ShieldCheck, Wallet,
} from 'lucide-react'
import { motion } from 'framer-motion'
import type { SettleProgressRow } from './types'
import { Sheet, ChainLogo, PrimaryBtn, GhostBtn, Divider } from './primitives'

export interface SettleProgressSheetProps {
  open: boolean
  running: boolean
  rows: SettleProgressRow[]
  onClose: () => void
  onRetryFailed: () => void
  onTrack: (id: string) => void
}

type Stage = SettleProgressRow['stage']

const STAGE_ORDER: Stage[] = ['sending', 'bridging', 'verifying', 'arrived']
const STAGE_LABELS: Record<Stage, string> = {
  waiting:    'Waiting',
  sending:    'Send',
  bridging:   'Bridge',
  verifying:  'Verify',
  arrived:    'Arrived',
  failed:     'Failed',
}
const STAGE_ICONS: Record<string, React.ElementType> = {
  sending:   Send,
  bridging:  Shuffle,
  verifying: ShieldCheck,
  arrived:   Wallet,
}

function stageIndex(stage: Stage): number {
  if (stage === 'waiting') return -1
  if (stage === 'failed')  return -2
  return STAGE_ORDER.indexOf(stage)
}

function MiniStepper({ stage }: { stage: Stage }) {
  const active = stageIndex(stage)
  if (stage === 'failed') return null

  return (
    <div className="flex items-center gap-0.5 mt-2">
      {STAGE_ORDER.map((s, i) => {
        const done    = active > i || stage === 'arrived'
        const current = active === i
        const Icon    = STAGE_ICONS[s]
        return (
          <React.Fragment key={s}>
            <div
              className={`flex flex-col items-center`}
            >
              <span
                className={`inline-flex items-center justify-center size-6 rounded-full text-[10px] transition-colors ${
                  done
                    ? 'bg-success/15 text-success'
                    : current
                    ? 'bg-brand/15 text-brand-text'
                    : 'bg-border/40 text-text-muted'
                }`}
              >
                {done ? <CheckCircle2 className="size-3" /> : <Icon className="size-3" />}
              </span>
              <span className={`text-[9px] mt-0.5 ${current ? 'text-brand-text' : done ? 'text-success' : 'text-text-muted'}`}>
                {STAGE_LABELS[s]}
              </span>
            </div>
            {i < STAGE_ORDER.length - 1 && (
              <div className={`h-px flex-1 mx-0.5 mb-3 ${i < active ? 'bg-success/40' : 'bg-border/50'}`} />
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}

function ProgressRow({
  row,
  onTrack,
}: {
  row: SettleProgressRow
  onTrack: (id: string) => void
}) {
  const isFailed    = row.stage === 'failed'
  const isArrived   = row.stage === 'arrived'
  const isActive    = !isFailed && !isArrived && row.stage !== 'waiting'

  return (
    <div className="py-4">
      <div className="flex items-start gap-3">
        <div className="relative">
          <ChainLogo src={row.logo} label={row.label} size={36} />
          {/* Stage indicator badge */}
          <span
            className={`absolute -bottom-0.5 -right-0.5 size-4 rounded-full flex items-center justify-center ring-2 ring-card ${
              isArrived
                ? 'bg-success'
                : isFailed
                ? 'bg-danger'
                : isActive
                ? 'bg-brand'
                : 'bg-border'
            }`}
          >
            {isArrived ? (
              <CheckCircle2 className="size-2.5 text-white" />
            ) : isFailed ? (
              <AlertCircle className="size-2.5 text-white" />
            ) : isActive ? (
              <Loader2 className="size-2.5 text-white animate-spin" />
            ) : null}
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-text-primary">{row.label}</p>
            <p className="text-sm font-semibold tabular-nums text-text-primary">{row.amount}</p>
          </div>
          {row.message && (
            <p className={`text-xs mt-0.5 ${isFailed ? 'text-danger' : 'text-text-muted'}`}>{row.message}</p>
          )}
          {isFailed ? (
            <button
              type="button"
              aria-label={`Track ${row.label} settlement`}
              onClick={() => onTrack(row.id)}
              className="mt-2 flex items-center gap-1 text-xs text-brand-text font-medium"
            >
              Track on explorer <ExternalLink className="size-3" />
            </button>
          ) : (
            <MiniStepper stage={row.stage} />
          )}
        </div>
      </div>
    </div>
  )
}

export function SettleProgressSheet({
  open,
  running,
  rows,
  onClose,
  onRetryFailed,
  onTrack,
}: SettleProgressSheetProps) {
  const arrivedCount = rows.filter((r) => r.stage === 'arrived').length
  const failedCount  = rows.filter((r) => r.stage === 'failed').length
  const total        = rows.length

  return (
    <Sheet open={open} onClose={onClose} height="full">
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-2 pb-4 shrink-0">
        <div>
          <p className="text-base font-semibold text-text-primary">Settlement progress</p>
          <p className="text-xs text-text-muted mt-0.5">
            {running
              ? `${arrivedCount} of ${total} arrived`
              : failedCount > 0
              ? `${failedCount} failed`
              : 'All arrived'}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close settlement progress"
          onClick={onClose}
          className="size-9 flex items-center justify-center rounded-xl text-text-muted hover:bg-border/40 transition-colors"
        >
          <X className="size-4.5" />
        </button>
      </div>

      {/* Overall progress bar */}
      <div className="mx-5 shrink-0">
        <div className="h-1.5 rounded-full bg-border/50 overflow-hidden">
          <motion.div
            className={`h-full rounded-full ${failedCount > 0 ? 'bg-danger' : 'bg-success'}`}
            initial={{ width: 0 }}
            animate={{ width: `${total > 0 ? (arrivedCount / total) * 100 : 0}%` }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          />
        </div>
      </div>

      {/* Scrollable chain list */}
      <div className="flex-1 overflow-y-auto px-5 pt-2">
        {rows.map((row, i) => (
          <React.Fragment key={row.id}>
            {i > 0 && <Divider />}
            <ProgressRow row={row} onTrack={onTrack} />
          </React.Fragment>
        ))}
      </div>

      {/* Footer */}
      <div className="shrink-0 px-5 pb-6 pt-3 border-t border-border flex flex-col gap-2">
        {failedCount > 0 ? (
          <>
            <PrimaryBtn onClick={onRetryFailed}>
              <span className="flex items-center justify-center gap-2">
                Retry {failedCount} failed
                <ArrowRight className="size-4" />
              </span>
            </PrimaryBtn>
            <GhostBtn onClick={onClose}>Done</GhostBtn>
          </>
        ) : (
          <PrimaryBtn onClick={onClose} disabled={running}>
            {running ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                Settling...
              </span>
            ) : (
              'Done'
            )}
          </PrimaryBtn>
        )}
      </div>
    </Sheet>
  )
}
