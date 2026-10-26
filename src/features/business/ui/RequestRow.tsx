/**
 * RequestRow — expandable row for payment requests and invoices.
 * Collapsed: title, sub, amount, status badge.
 * Expanded: action buttons revealed below.
 */
import React from 'react'
import { ChevronDown } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { EASE_OUT } from '@/lib/motion'
import { springs } from './types'

export type RequestStatus = 'open' | 'part' | 'paid' | 'completed' | 'expired' | 'cancelled'
export type RequestKind   = 'request' | 'invoice'
export type ActionTone    = 'neutral' | 'brand' | 'danger'

export interface RequestAction {
  label: string
  tone: ActionTone
  onClick: () => void
  disabled?: boolean
}

export interface RequestRowProps {
  title: string
  sub: string
  amount: string
  status: RequestStatus
  kind: RequestKind
  expanded: boolean
  onToggle: () => void
  actions: RequestAction[]
  /** Extra state shown under the status: "Due 25 Oct", "Overpaid $2.00", "Blocked sender"… */
  badges?: Array<{ label: string; tone: 'neutral' | 'warning' | 'danger' }>
  /** Shown above the actions when expanded (why an action is needed) */
  note?: string
}

const STATUS_STYLES: Record<RequestStatus, { label: string; bg: string; text: string }> = {
  open:      { label: 'Open',      bg: 'bg-brand/10',   text: 'text-brand-text' },
  part:      { label: 'Partial',   bg: 'bg-warning/10', text: 'text-warning' },
  paid:      { label: 'Paid',      bg: 'bg-success/10', text: 'text-success' },
  completed: { label: 'Completed', bg: 'bg-success/10', text: 'text-success' },
  expired:   { label: 'Expired',   bg: 'bg-border/40',  text: 'text-text-muted' },
  cancelled: { label: 'Cancelled', bg: 'bg-border/40',  text: 'text-text-muted' },
}

const BADGE_STYLES = {
  neutral: 'bg-border/40 text-text-secondary',
  warning: 'bg-warning/10 text-warning',
  danger:  'bg-danger/10 text-danger',
} as const

const KIND_LABEL: Record<RequestKind, string> = {
  request: 'Request',
  invoice: 'Invoice',
}

const ACTION_STYLES: Record<ActionTone, string> = {
  neutral: 'bg-surface border border-border text-text-secondary hover:border-text-muted',
  brand:   'bg-brand text-white hover:bg-brand/90',
  danger:  'bg-danger/10 text-danger hover:bg-danger/20',
}

export function RequestRow({
  title,
  sub,
  amount,
  status,
  kind,
  expanded,
  onToggle,
  actions,
  badges = [],
  note,
}: RequestRowProps) {
  const s = STATUS_STYLES[status]

  return (
    <div className="rounded-2xl bg-surface border border-border overflow-hidden">
      {/* Header row — always visible */}
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${KIND_LABEL[kind]}: ${title}`}
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-border/20 transition-colors"
      >
        {/* Kind badge */}
        <span className="shrink-0 text-[11px] font-semibold text-text-muted bg-border/40 rounded-lg px-2 py-1 uppercase tracking-wide">
          {KIND_LABEL[kind]}
        </span>

        {/* Title + sub */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-text-primary truncate">{title}</p>
          <p className="text-xs text-text-muted mt-0.5 truncate">{sub}</p>
          {badges.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {badges.map(b => (
                <span key={b.label} className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${BADGE_STYLES[b.tone]}`}>{b.label}</span>
              ))}
            </div>
          )}
        </div>

        {/* Amount + status + chevron */}
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className="text-sm font-bold tabular-nums text-text-primary">{amount}</span>
          <span className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${s.bg} ${s.text}`}>
            {s.label}
          </span>
        </div>

        <motion.span
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={springs.snappy}
          className="ml-1 shrink-0 text-text-muted"
        >
          <ChevronDown className="size-4" />
        </motion.span>
      </button>

      {/* Expandable actions */}
      <AnimatePresence initial={false}>
        {expanded && (actions.length > 0 || note) && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            {note && <p className="px-4 pt-3 text-xs text-text-secondary leading-relaxed border-t border-border">{note}</p>}
            <div className={`flex flex-wrap gap-2 px-4 pb-4 ${note ? 'pt-3' : 'pt-1 border-t border-border'}`}>
              {actions.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  onClick={a.onClick}
                  disabled={a.disabled}
                  className={`rounded-xl px-4 py-2.5 text-xs font-semibold transition active:scale-[0.97] min-h-[40px] disabled:opacity-40 disabled:cursor-not-allowed ${ACTION_STYLES[a.tone]}`}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
