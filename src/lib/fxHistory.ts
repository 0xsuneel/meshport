// Past exchange rates (fx_rate_history), for exports that need a payment's
// local-currency value at the time it arrived. The database appends a row
// each time the USD rate it fetches changes (about once a day). USDC is
// counted as 1 USD.
import { supabase } from './supabase'

export type FxPoint = { usdRate: number; at: string }

/**
 * Rates for `currency` covering [fromIso, toIso]: every change inside the
 * range plus the last one before it (the rate in effect at its start).
 * Oldest first. Empty when nothing could be read.
 */
export async function fetchFxHistory(currency: string, fromIso: string, toIso: string): Promise<FxPoint[]> {
  const map = (rows: any[] | null) => (rows ?? []).map(r => ({ usdRate: Number(r.usd_rate), at: r.rate_at as string }))
    .filter(r => r.usdRate > 0 && !!r.at)
  const [before, inside] = await Promise.all([
    supabase.from('fx_rate_history').select('usd_rate, rate_at').eq('currency', currency)
      .lte('rate_at', fromIso).order('rate_at', { ascending: false }).limit(1),
    supabase.from('fx_rate_history').select('usd_rate, rate_at').eq('currency', currency)
      .gt('rate_at', fromIso).lte('rate_at', toIso).order('rate_at', { ascending: true }).limit(2000),
  ])
  const pts = [...map(before.data), ...map(inside.data)]
  // Nothing at or before the range's end (history started later): the
  // earliest rate there is, so older payments still get a value.
  if (!pts.length) {
    const { data } = await supabase.from('fx_rate_history').select('usd_rate, rate_at').eq('currency', currency)
      .order('rate_at', { ascending: true }).limit(1)
    return map(data)
  }
  return pts
}

/**
 * The rate in effect at `iso`: the latest point at or before it. A time
 * before the first point gets the first point, flagged `before: true`, so
 * the export can say the rate is the nearest one held rather than the rate
 * on that day. Null without any points. `history` is oldest first.
 */
export function rateAt(history: FxPoint[], iso: string): (FxPoint & { before: boolean }) | null {
  if (!history.length) return null
  const t = Date.parse(iso)
  let hit: FxPoint | null = null
  for (const p of history) {
    if (Date.parse(p.at) <= t) hit = p
    else break
  }
  return hit ? { ...hit, before: false } : { ...history[0], before: true }
}
