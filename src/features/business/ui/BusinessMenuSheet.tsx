/**
 * BusinessMenuSheet — "Business menu" bottom sheet with grouped action rows.
 * Groups: Money, Store, Account. Each row has an icon tile, label, hint, chevron.
 */
import React from 'react'
import {
  Banknote, FileText, BarChart2,
  Store, Users, Mic,
  ShieldCheck, HelpCircle, QrCode,
  ChevronRight,
} from 'lucide-react'
import { Sheet } from './primitives'

// ─── Types ────────────────────────────────────────────────────────────────────

export type MenuIconId =
  | 'cashout'
  | 'statement'
  | 'insights'
  | 'stores'
  | 'staff'
  | 'voice'
  | 'profile'
  | 'help'
  | 'sticker'

export interface MenuItem {
  id: string
  label: string
  hint?: string
  icon: MenuIconId
  badge?: string
  onClick: () => void
}

export interface MenuGroup {
  title: string
  items: MenuItem[]
}

export interface BusinessMenuSheetProps {
  open: boolean
  onClose: () => void
  groups: MenuGroup[]
}

// ─── Icon map ─────────────────────────────────────────────────────────────────

const ICON_MAP: Record<MenuIconId, React.ElementType> = {
  cashout:   Banknote,
  statement: FileText,
  insights:  BarChart2,
  stores:    Store,
  staff:     Users,
  voice:     Mic,
  profile:   ShieldCheck,
  help:      HelpCircle,
  sticker:   QrCode,
}

// Icon background tones per icon (subtle, brand-adjacent)
const ICON_TONE: Partial<Record<MenuIconId, string>> = {
  cashout:   'bg-success/10 text-success',
  statement: 'bg-brand/10 text-brand-text',
  insights:  'bg-brand/10 text-brand-text',
  stores:    'bg-warning/10 text-warning',
  staff:     'bg-brand/10 text-brand-text',
  voice:     'bg-brand/10 text-brand-text',
  profile:   'bg-success/10 text-success',
  help:      'bg-border/60 text-text-secondary',
  sticker:   'bg-brand/10 text-brand-text',
}

// ─── Component ────────────────────────────────────────────────────────────────

export function BusinessMenuSheet({ open, onClose, groups }: BusinessMenuSheetProps) {
  return (
    <Sheet open={open} onClose={onClose}>
      <div className="px-4 pt-2 overflow-y-auto max-h-[80dvh]" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)' }}>
      <p className="text-base font-semibold text-text-primary mb-4 px-1">Business menu</p>

      <div className="flex flex-col gap-5">
        {groups.map((group, gi) => (
          <div key={gi}>
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-2 px-1">
              {group.title}
            </p>
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const Icon = ICON_MAP[item.icon]
                const tone = ICON_TONE[item.icon] ?? 'bg-border/60 text-text-secondary'

                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-label={item.label}
                    onClick={() => { item.onClick(); onClose() }}
                    className="flex items-center gap-3.5 px-3 py-3 rounded-2xl hover:bg-card active:bg-card active:scale-[0.99] transition-all"
                  >
                    {/* Icon tile */}
                    <span className={`inline-flex items-center justify-center size-10 rounded-xl shrink-0 ${tone}`}>
                      <Icon className="size-4.5" />
                    </span>

                    {/* Text */}
                    <div className="flex-1 min-w-0 text-left">
                      <p className="text-sm font-medium text-text-primary">{item.label}</p>
                      {item.hint && (
                        <p className="text-xs text-text-muted mt-0.5 truncate">{item.hint}</p>
                      )}
                    </div>

                    {/* Badge */}
                    {item.badge && (
                      <span className="shrink-0 px-2 py-0.5 rounded-full bg-brand/10 text-brand-text text-[10px] font-bold">
                        {item.badge}
                      </span>
                    )}

                    <ChevronRight className="size-4 text-text-muted shrink-0" />
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      </div>
    </Sheet>
  )
}
