// Business → the date filter shared by Overview, Payments and Settlements:
// Today, Yesterday, Last 7 days, This month or a custom range, plus the
// period right before it for the "vs …" comparison.
export type PeriodId = 'today' | 'yesterday' | 'week' | 'month' | 'custom'
export type Period = { id: PeriodId; from: Date; to: Date; label: string; compareLabel: string; prevFrom: Date; prevTo: Date }

const dayStart = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
const fmt = (d: Date) => d.toLocaleDateString([], { day: 'numeric', month: 'short' })

/** `custom` is { from, to } as yyyy-mm-dd (inclusive). */
export function makePeriod(id: PeriodId, custom?: { from: string; to: string }): Period {
  const today = dayStart(new Date())
  let from: Date, to: Date, label: string, compareLabel: string
  switch (id) {
    case 'yesterday': from = addDays(today, -1); to = today; label = 'Yesterday'; compareLabel = 'day before'; break
    case 'week': from = addDays(today, -6); to = addDays(today, 1); label = 'Last 7 days'; compareLabel = 'previous 7 days'; break
    case 'month': from = new Date(today.getFullYear(), today.getMonth(), 1); to = addDays(today, 1); label = 'This month'; compareLabel = 'last month'; break
    case 'custom': {
      from = custom?.from ? dayStart(new Date(custom.from + 'T00:00')) : addDays(today, -29)
      to = custom?.to ? addDays(dayStart(new Date(custom.to + 'T00:00')), 1) : addDays(today, 1)
      if (to <= from) to = addDays(from, 1)
      label = `${fmt(from)} – ${fmt(addDays(to, -1))}`; compareLabel = 'previous period'; break
    }
    default: from = today; to = addDays(today, 1); label = 'Today'; compareLabel = 'yesterday'
  }
  const len = to.getTime() - from.getTime()
  const prevTo = id === 'month' ? from : from
  const prevFrom = id === 'month' ? new Date(from.getFullYear(), from.getMonth() - 1, 1) : new Date(from.getTime() - len)
  return { id, from, to, label, compareLabel, prevFrom, prevTo }
}

export const inPeriod = (iso: string, p: { from: Date; to: Date }) => { const t = Date.parse(iso); return t >= p.from.getTime() && t < p.to.getTime() }
export const inPrevious = (iso: string, p: Period) => { const t = Date.parse(iso); return t >= p.prevFrom.getTime() && t < p.prevTo.getTime() }

/** Change vs the period before, in percent; null when that period had nothing. */
export function periodTrend(now: number, before: number): number | null {
  return before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null
}

export const periodText = (p: Period) => p.id === 'today' || p.id === 'yesterday'
  ? p.from.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  : `${fmt(p.from)} – ${fmt(addDays(p.to, -1))} ${addDays(p.to, -1).getFullYear()}`

const KEY = 'meshport_business_period'
export function savedPeriod(): { id: PeriodId; from: string; to: string } {
  try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v?.id) return v } catch { /* storage off */ }
  return { id: 'today', from: '', to: '' }
}
export function savePeriod(v: { id: PeriodId; from: string; to: string }) { try { localStorage.setItem(KEY, JSON.stringify(v)) } catch { /* storage off */ } }
