/**
 * Profile screen components: ProfileStatusCard and DetailList.
 */
import React from 'react'
import { Sparkles, ShieldCheck, AlertTriangle, AlertCircle } from 'lucide-react'
import { Divider } from './primitives'

// ─── ProfileStatusCard ───────────────────────────────────────────────────────

export type StatusCardTone = 'brand' | 'success' | 'warning' | 'danger'

export interface ProfileStatusCardProps {
  tone: StatusCardTone
  title: string
  text: string
}

const CARD_STYLES: Record<
  StatusCardTone,
  { bg: string; border: string; Icon: React.ElementType; iconColor: string; titleColor: string; textColor: string }
> = {
  brand:   { bg: 'bg-brand/10',    border: 'border-brand/20',   Icon: Sparkles,     iconColor: 'text-brand-text', titleColor: 'text-brand-text',   textColor: 'text-brand-text/70' },
  success: { bg: 'bg-success/10',  border: 'border-success/20', Icon: ShieldCheck,  iconColor: 'text-success',    titleColor: 'text-success',      textColor: 'text-success/70' },
  warning: { bg: 'bg-warning/10',  border: 'border-warning/20', Icon: AlertTriangle,iconColor: 'text-warning',    titleColor: 'text-warning',      textColor: 'text-warning/70' },
  danger:  { bg: 'bg-danger/10',   border: 'border-danger/20',  Icon: AlertCircle,  iconColor: 'text-danger',     titleColor: 'text-danger',       textColor: 'text-danger/70' },
}

export function ProfileStatusCard({ tone, title, text }: ProfileStatusCardProps) {
  const s = CARD_STYLES[tone]
  return (
    <div className={`rounded-2xl border p-4 ${s.bg} ${s.border}`}>
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 shrink-0 ${s.iconColor}`}>
          <s.Icon className="size-4" />
        </span>
        <div>
          <p className={`text-sm font-semibold ${s.titleColor}`}>{title}</p>
          <p className={`mt-0.5 text-xs leading-relaxed ${s.textColor}`}>{text}</p>
        </div>
      </div>
    </div>
  )
}

// ─── DetailList ──────────────────────────────────────────────────────────────

export interface DetailRow {
  label: string
  value: string
}

export interface DetailListProps {
  rows: DetailRow[]
}

export function DetailList({ rows }: DetailListProps) {
  return (
    <div className="rounded-2xl bg-surface soft-card overflow-hidden">
      {rows.map((row, i) => (
        <React.Fragment key={row.label}>
          {i > 0 && <Divider className="mx-4" />}
          <div className="flex items-center justify-between px-4 py-3.5 gap-4">
            <span className="text-xs text-text-muted shrink-0">{row.label}</span>
            <span className="text-sm font-medium text-text-primary text-right break-all">{row.value}</span>
          </div>
        </React.Fragment>
      ))}
    </div>
  )
}
