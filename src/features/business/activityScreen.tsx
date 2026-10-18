// Business → Business tools → Activity log: who did what - the owner and
// staff - newest first, by person and by day. Rows come from the database
// (lib/businessActivity).
import { useEffect, useMemo, useState } from 'react'
import { History, X } from 'lucide-react'
import { useBizTerms, cap } from '@/lib/businessCategories'
import { listActivity, listActivityPeople, actionLabel, type ActivityRow } from '@/lib/businessActivity'
import { displayOrderNumber } from '@/lib/merchantPay'
import { isoDay } from '@/lib/businessBills'
import { useAuthStore } from '@/store'
import { BusinessScreen, Skeleton, GhostBtn, TextInput } from './ui'
import { formatDay } from './ui/types'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** "Created a bill · ORD-00012", "Invited staff · ravi.arc (cashier)". */
function describe(r: ActivityRow, t: ReturnType<typeof useBizTerms>): string {
  const target = r.target && /^ORD-\d+$/i.test(r.target) ? displayOrderNumber(r.target) : r.target
  // Stores: "Added Main outlet", "Edited Andheri (was Andheri West)".
  if (r.action.startsWith('store_')) return `${actionLabel(r.action)} ${target ?? ''}${typeof r.meta.old_name === 'string' ? ` (was ${r.meta.old_name})` : ''}`.trim()
  const label = r.action === 'order_cancelled' ? `Cancelled ${t.order}`
    : r.action === 'order_completed' ? `Marked ${t.order} completed`
    : actionLabel(r.action)
  const role = typeof r.meta.role === 'string' && r.action.startsWith('staff_') ? ` (${r.meta.old_role ? `${r.meta.old_role} → ` : ''}${r.meta.role})` : ''
  const customer = typeof r.meta.customer === 'string' && r.action !== 'reminder_sent' ? `for ${r.meta.customer}.arc` : null
  return [label, target && `${target}${role}`, customer].filter(Boolean).join(' · ')
}

export function ActivityScreen({ open, onBack }: { open: boolean; onBack: () => void }) {
  const t = useBizTerms()
  const me = useAuthStore(s => s.username)
  const [people, setPeople] = useState<Array<{ id: string; username: string | null }>>([])
  const [actor, setActor] = useState<string | null>(null)
  const [day, setDay] = useState('')
  const [rows, setRows] = useState<ActivityRow[] | null>(null)
  const [page, setPage] = useState(0)
  const [more, setMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => { if (open) listActivityPeople().then(setPeople).catch(() => {}); else { setActor(null); setDay('') } }, [open])
  useEffect(() => {
    if (!open) return
    let live = true
    setRows(null); setPage(0); setError(false)
    listActivity({ actor, day: day || null, page: 0 }).then(r => { if (live) { setRows(r.rows); setMore(r.more) } })
      .catch(() => { if (live) { setRows([]); setError(true) } })
    return () => { live = false }
  }, [open, actor, day])
  const loadMore = async () => {
    setLoadingMore(true)
    try { const r = await listActivity({ actor, day: day || null, page: page + 1 }); setRows(x => [...(x ?? []), ...r.rows]); setMore(r.more); setPage(page + 1) }
    catch { /* keep what's shown */ }
    setLoadingMore(false)
  }
  const groups = useMemo(() => {
    const m = new Map<string, ActivityRow[]>()
    for (const r of rows ?? []) { const k = new Date(r.createdAt).toDateString(); m.set(k, [...(m.get(k) ?? []), r]) }
    return [...m.entries()]
  }, [rows])
  const name = (r: ActivityRow) => r.actorUsername ? (r.actorUsername === me ? 'You' : `${r.actorUsername}.arc`) : 'MeshPort'

  return (
    <BusinessScreen open={open} title="Activity log" onBack={onBack}>
      <div className="flex flex-col gap-3 px-5 pt-4 pb-8">
        <div className="flex gap-2 overflow-x-auto -mx-5 px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist" aria-label="Person">
          {[{ id: null as string | null, label: 'Everyone' }, ...people.map(p => ({ id: p.id as string | null, label: p.username ? (p.username === me ? 'You' : `${p.username}.arc`) : 'Unknown' }))].map(p => {
            const on = actor === p.id
            return (
              <button key={p.id ?? 'all'} type="button" role="tab" aria-selected={on} onClick={() => setActor(p.id)}
                className={`shrink-0 rounded-full px-3.5 min-h-[36px] text-xs font-semibold transition-colors ${on ? 'bg-brand text-white' : 'bg-surface border border-border text-text-secondary'}`}>
                {p.label}
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-2">
          <TextInput type="date" value={day} max={isoDay(new Date())} onChange={e => setDay(e.target.value)} aria-label="Day" />
          {day && (
            <button type="button" aria-label="Show all days" onClick={() => setDay('')}
              className="shrink-0 size-12 inline-flex items-center justify-center rounded-2xl border border-border text-text-muted active:bg-border/30">
              <X className="size-4" />
            </button>
          )}
        </div>
        {rows === null ? (
          <div className="flex flex-col gap-2 pt-2">{[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-14 w-full" />)}</div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center text-center py-14">
            <span className="inline-flex items-center justify-center size-12 rounded-2xl bg-surface border border-border mb-3"><History className="size-5 text-text-muted" /></span>
            <p className="text-sm font-medium text-text-secondary">{error ? 'Could not load the activity log' : day || actor ? 'Nothing here for this filter' : 'No activity yet'}</p>
            <p className="text-xs text-text-muted mt-1 max-w-[260px]">{cap(t.orders)}, refunds, settles, payouts and staff changes - by you and your staff - show up here.</p>
          </div>
        ) : (
          <>
            {groups.map(([key, items]) => (
              <div key={key}>
                <p className="px-1 pt-2 pb-2 text-xs font-semibold uppercase tracking-wider text-text-muted">{formatDay(new Date(key).toISOString())}</p>
                <div className="rounded-2xl bg-surface border border-border overflow-hidden divide-y divide-border">
                  {items.map(r => (
                    <div key={r.id} className="flex items-start gap-3 px-4 py-3">
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm text-text-primary"><b className="font-semibold">{name(r)}</b> <span className="text-text-secondary">{describe(r, t).replace(/^./, c => c.toLowerCase())}</span></span>
                        <span className="block text-xs text-text-muted mt-0.5">{new Date(r.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                      </span>
                      {r.amount != null && <span className="text-sm font-semibold tabular-nums text-text-primary shrink-0">{money(r.amount)}</span>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {more && <GhostBtn disabled={loadingMore} onClick={loadMore}>{loadingMore ? 'Loading…' : 'Show more'}</GhostBtn>}
          </>
        )}
      </div>
    </BusinessScreen>
  )
}
