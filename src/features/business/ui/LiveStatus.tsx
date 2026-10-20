/**
 * LiveStatus — single-line status indicator with tone, icon, and spinner for in-flight states.
 */
import React from 'react'
import { CheckCircle2, XCircle, AlertCircle, Clock, Loader2, AlertTriangle } from 'lucide-react'

export type LiveStatusKind =
  | 'waiting'
  | 'detected'
  | 'partial'
  | 'paid'
  | 'expired'
  | 'cancelled'
  | 'failed'

export interface LiveStatusProps {
  status: LiveStatusKind
  text: string
  /** No pill - just the icon and text, inside another line (a QR card's
   *  caption on a screen that's short on room). */
  inline?: boolean
}

const CONFIG: Record<
  LiveStatusKind,
  { Icon: React.ElementType; color: string; bg: string; spin?: boolean }
> = {
  waiting:   { Icon: Clock,         color: 'text-text-muted',    bg: 'bg-border/40' },
  detected:  { Icon: Loader2,       color: 'text-brand-text',    bg: 'bg-brand/10',   spin: true },
  partial:   { Icon: AlertTriangle, color: 'text-warning',       bg: 'bg-warning/10' },
  paid:      { Icon: CheckCircle2,  color: 'text-success',       bg: 'bg-success/10' },
  expired:   { Icon: AlertCircle,   color: 'text-text-muted',    bg: 'bg-border/40' },
  cancelled: { Icon: XCircle,       color: 'text-text-muted',    bg: 'bg-border/40' },
  failed:    { Icon: XCircle,       color: 'text-danger',        bg: 'bg-danger/10' },
}

export function LiveStatus({ status, text, inline = false }: LiveStatusProps) {
  const { Icon, color, bg, spin } = CONFIG[status]
  if (inline) {
    return (
      <span className={`inline-flex items-center gap-1.5 ${status === 'waiting' ? 'text-text-primary' : color}`}>
        <Icon className={`size-3.5 shrink-0 ${spin ? 'animate-spin' : ''}`} />{text}
      </span>
    )
  }
  return (
    <div className={`inline-flex items-center gap-2 rounded-2xl px-3.5 py-2.5 ${bg}`}>
      <Icon className={`size-4 shrink-0 ${color} ${spin ? 'animate-spin' : ''}`} />
      <span className={`text-sm font-medium ${color}`}>{text}</span>
    </div>
  )
}
