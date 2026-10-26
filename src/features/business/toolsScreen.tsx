// Business → Business tools: everything that runs the business besides
// taking payments (stores, staff, customers, reports, payouts, cash out,
// profile and limits, voice alerts, help, activity log). Opened from the home tile and
// the header's menu button.
import { ChevronRight, Store, Users, UserRound, BarChart2, Send, Banknote, ShieldCheck, Mic, HelpCircle, History } from 'lucide-react'
import { BusinessScreen } from './ui'

export type ToolId = 'team' | 'customers' | 'reports' | 'activity' | 'payouts' | 'cashout' | 'profile' | 'voice' | 'help'

const ICONS: Record<ToolId, React.ElementType> = {
  team: Store, customers: UserRound, reports: BarChart2, activity: History, payouts: Send, cashout: Banknote, profile: ShieldCheck, voice: Mic, help: HelpCircle,
}

export type ToolRow = { id: ToolId; label: string; hint: string }

export function ToolsScreen({ open, onBack, groups, onOpen }: {
  open: boolean; onBack: () => void
  groups: Array<{ title: string; rows: ToolRow[] }>
  onOpen: (id: ToolId) => void
}) {
  return (
    <BusinessScreen open={open} title="Business tools" onBack={onBack}>
      <div className="flex flex-col gap-5 px-5 pt-4 pb-8">
        {groups.map(g => (
          <div key={g.title}>
            <p className="px-1 mb-2 text-xs font-semibold text-text-muted">{g.title}</p>
            <div className="rounded-2xl bg-card border border-border overflow-hidden divide-y divide-border">
              {g.rows.map(r => {
                const Icon = ICONS[r.id] ?? Users
                return (
                  <button key={r.id} type="button" onClick={() => onOpen(r.id)}
                    className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-border/20 transition-colors">
                    <span className="inline-flex items-center justify-center size-9 rounded-xl bg-brand/10 text-brand-text shrink-0"><Icon className="size-[18px]" /></span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[15px] font-semibold text-text-primary">{r.label}</span>
                      <span className="block text-xs text-text-muted truncate">{r.hint}</span>
                    </span>
                    <ChevronRight className="size-4 text-text-muted shrink-0" />
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </BusinessScreen>
  )
}
