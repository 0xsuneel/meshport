/**
 * KpiGrid — 2×2 grid of compact KPI tiles.
 */
import React from 'react'
import {
  Banknote, CreditCard, ArrowDownToLine, RotateCcw, Zap,
} from 'lucide-react'
import { Skeleton } from './primitives'

export type KpiIcon = 'collection' | 'payments' | 'arriving' | 'refunded' | 'arc'
export type KpiTone = 'default' | 'success' | 'warning' | 'danger'

export interface KpiItem {
  id: string
  label: string
  value: string
  hint?: string
  tone?: KpiTone
  icon: KpiIcon
}

export interface KpiGridProps {
  loading?: boolean
  items: KpiItem[]
}

const ICON_MAP: Record<KpiIcon, React.ElementType> = {
  collection: Banknote,
  payments:   CreditCard,
  arriving:   ArrowDownToLine,
  refunded:   RotateCcw,
  arc:        Zap,
}

const TONE_CLASSES: Record<KpiTone, { icon: string; value: string }> = {
  default: { icon: 'bg-brand/10 text-brand-text',   value: 'text-text-primary' },
  success: { icon: 'bg-success/10 text-success',     value: 'text-success' },
  warning: { icon: 'bg-warning/10 text-warning',     value: 'text-warning' },
  danger:  { icon: 'bg-danger/10 text-danger',       value: 'text-danger' },
}

export function KpiGrid({ loading, items }: KpiGridProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-3 px-5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-card rounded-2xl p-4 flex flex-col gap-3">
            <Skeleton className="size-9 rounded-xl" />
            <Skeleton className="h-5 w-20 rounded" />
            <Skeleton className="h-3.5 w-14 rounded" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3 px-5">
      {items.map(item => {
        const Icon  = ICON_MAP[item.icon]
        const tone  = item.tone ?? 'default'
        const tones = TONE_CLASSES[tone]

        return (
          <div
            key={item.id}
            className="bg-card rounded-2xl p-4 flex flex-col gap-2 border border-border/50"
          >
            <span className={`inline-flex items-center justify-center size-9 rounded-xl ${tones.icon}`}>
              <Icon className="size-4.5" />
            </span>
            <p className={`text-xl font-bold tabular-nums leading-tight ${tones.value}`}>
              {item.value}
            </p>
            <p className="text-xs text-text-secondary font-medium">{item.label}</p>
            {item.hint && (
              <p className="text-xs text-text-muted">{item.hint}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}
