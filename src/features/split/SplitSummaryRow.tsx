// Pay → "Split summary" (as PhonePe's Send Money): one row to every split,
// with where you stand - all settled, what you're owed, or what you owe.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { mySplits, money, SPLITS_CHANGED_EVENT } from '@/lib/splits'

// Last reading, so the pill shows at once on the next visit.
let cached: { owed: number; owe: number; any: boolean } | null = null

export function SplitSummaryRow() {
  const navigate = useNavigate()
  const [v, setV] = useState(cached)
  useEffect(() => {
    let live = true
    const load = () => mySplits().then(d => {
      const owed = d.made.reduce((a, s) => a + s.owedLeft, 0)
      const owe = d.owe.filter(o => (o.status === 'pending' || o.status === 'partially_paid') && o.left > 0).reduce((a, o) => a + o.left, 0)
      cached = { owed, owe, any: d.made.length + d.owe.length > 0 }
      if (live) setV(cached)
    }).catch(() => {})
    load()
    window.addEventListener(SPLITS_CHANGED_EVENT, load)
    return () => { live = false; window.removeEventListener(SPLITS_CHANGED_EVENT, load) }
  }, [])
  const pill = !v ? null
    : v.owe > 0 ? { text: `You owe ${money(v.owe)}`, fg: 'var(--warning-text)', bg: 'color-mix(in srgb, var(--warning) 15%, transparent)' }
    : v.owed > 0 ? { text: `You're owed ${money(v.owed)}`, fg: 'var(--brand-text)', bg: 'color-mix(in srgb, var(--brand) 13%, transparent)' }
    : v.any ? { text: 'All settled! 🎉', fg: 'var(--text-secondary)', bg: 'color-mix(in srgb, var(--text-primary) 7%, transparent)' }
    : { text: 'Split Expense', fg: 'var(--brand-text)', bg: 'color-mix(in srgb, var(--brand) 13%, transparent)' }
  return (
    <button type="button" onClick={() => navigate('/splits')}
      className="w-full flex items-center gap-3 rounded-2xl px-4 py-3.5 text-left active:scale-[0.99] transition-transform"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <span aria-hidden className="flex items-center justify-center flex-shrink-0 rounded-xl" style={{ width: 40, height: 40, background: 'color-mix(in srgb, var(--brand) 12%, transparent)', fontSize: 20 }}>🧾</span>
      <span className="flex-1 min-w-0 text-[15px] font-semibold text-text-primary whitespace-nowrap truncate">Split summary</span>
      {pill && <span className="text-[12px] font-bold rounded-full px-2.5 py-1 whitespace-nowrap" style={{ color: pill.fg, background: pill.bg }}>{pill.text}</span>}
      <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-secondary)' }} />
    </button>
  )
}
