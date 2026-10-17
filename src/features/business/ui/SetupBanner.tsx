/**
 * SetupBanner — dismissible top-of-page call-to-action strip.
 * Shown until the business is approved (tone='brand') or if there's an issue (warning/danger).
 */
import React from 'react'
import { AlertTriangle, AlertCircle, ArrowRight, Sparkles } from 'lucide-react'

export type BannerTone = 'brand' | 'warning' | 'danger'

export interface SetupBannerProps {
  tone: BannerTone
  title: string
  text: string
  action: string
  onAction: () => void
}

const toneStyles: Record<
  BannerTone,
  { bg: string; border: string; title: string; text: string; btn: string; Icon: React.ElementType }
> = {
  brand: {
    bg:     'bg-brand/10',
    border: 'border-brand/20',
    title:  'text-brand-text',
    text:   'text-brand-text/80',
    btn:    'bg-brand text-white hover:bg-brand/90',
    Icon:   Sparkles,
  },
  warning: {
    bg:     'bg-warning/10',
    border: 'border-warning/20',
    title:  'text-warning',
    text:   'text-warning/80',
    btn:    'bg-warning/20 text-warning hover:bg-warning/30',
    Icon:   AlertTriangle,
  },
  danger: {
    bg:     'bg-danger/10',
    border: 'border-danger/20',
    title:  'text-danger',
    text:   'text-danger/80',
    btn:    'bg-danger/20 text-danger hover:bg-danger/30',
    Icon:   AlertCircle,
  },
}

export function SetupBanner({ tone, title, text, action, onAction }: SetupBannerProps) {
  const s = toneStyles[tone]

  return (
    <div className={`mx-5 mt-3 rounded-2xl border p-4 ${s.bg} ${s.border}`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          <s.Icon className={`size-4 ${s.title}`} />
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-semibold ${s.title}`}>{title}</p>
          <p className={`mt-0.5 text-xs leading-relaxed ${s.text}`}>{text}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={onAction}
        className={`mt-3 flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold transition-colors ${s.btn}`}
      >
        {action}
        <ArrowRight className="size-3.5" />
      </button>
    </div>
  )
}
