// Splits: what you're owed (splits you made) and what you owe (your share
// of someone else's split), Open or Settled. + New split starts one.
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { mySplits, money, isSettled, SPLITS_CHANGED_EVENT, type MySplitMade, type MySplitOwe } from '@/lib/splits'
import { SplitHeader, ListCard, card, rowStyle, subStyle, nameStyle, amountStyle, when, SplitListSkeleton } from './splitUi'

type Tab = 'open' | 'settled'
const oweOpen = (o: MySplitOwe) => (o.status === 'pending' || o.status === 'partially_paid') && o.left > 0

export function SplitsPage() {
  const navigate = useNavigate()
  const [data, setData] = useState<{ made: MySplitMade[]; owe: MySplitOwe[] } | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('open')
  const load = useCallback(() => mySplits().then(d => { setData(d); setError('') }).catch(e => setError(e instanceof Error ? e.message : 'Could not load splits')), [])
  useEffect(() => {
    void load()
    const on = () => void load()
    window.addEventListener(SPLITS_CHANGED_EVENT, on)
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 15000)
    return () => { window.removeEventListener(SPLITS_CHANGED_EVENT, on); clearInterval(t) }
  }, [load])

  const owedToMe = (data?.made ?? []).reduce((a, s) => a + s.owedLeft, 0)
  const iOwe = (data?.owe ?? []).filter(oweOpen).reduce((a, o) => a + o.left, 0)
  type Row = { key: string; at: string; node: React.ReactNode }
  const rows: Row[] = []
  for (const s of data?.made ?? []) {
    const done = isSettled(s)
    if ((tab === 'open') === done) continue
    rows.push({ key: `m${s.id}`, at: s.createdAt, node: (
      <button type="button" onClick={() => navigate(`/splits/${s.id}`)} style={{ ...rowStyle, width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}>
        <div aria-hidden style={{ width: 40, textAlign: 'center', fontSize: 24, flexShrink: 0 }}>{s.emoji || '🧾'}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={nameStyle}>{s.title}</div>
          <div style={subStyle}>You split {money(s.total)} · {s.paidCount} of {s.requests} paid back</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ ...amountStyle, color: done ? 'var(--text-secondary)' : 'var(--brand-text)' }}>{done ? money(s.total - s.myShare) : `+${money(s.owedLeft)}`}</div>
          <div style={subStyle}>{done ? 'settled' : 'owed'}</div>
        </div>
      </button>
    ) })
  }
  for (const o of data?.owe ?? []) {
    const open = oweOpen(o)
    if ((tab === 'open') !== open) continue
    rows.push({ key: `o${o.code}`, at: o.createdAt, node: (
      <button type="button" onClick={() => navigate(`/splits/${o.splitId}`)} style={{ ...rowStyle, width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}>
        <div aria-hidden style={{ width: 40, textAlign: 'center', fontSize: 24, flexShrink: 0 }}>{o.emoji || '🧾'}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={nameStyle}>{o.title}</div>
          <div style={subStyle}>{o.creator.name ?? `${o.creator.username}.arc`} paid · {open ? when(o.createdAt) : `you paid ${when(o.paidAt)}`}</div>
        </div>
        <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
          <div style={{ ...amountStyle, color: open ? 'var(--warning-text)' : 'var(--text-secondary)' }}>{open ? `−${money(o.left)}` : money(o.amount)}</div>
          {open ? <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 999, background: 'var(--brand)', color: '#fff' }}>Pay</span> : <div style={subStyle}>paid</div>}
        </div>
      </button>
    ) })
  }
  rows.sort((a, b) => (a.at < b.at ? 1 : -1))

  return (
    <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', background: 'var(--bg)', paddingBottom: 90 }}>
      <SplitHeader title="Split Expense" onBack={() => navigate(-1)} right={
        <button type="button" onClick={() => navigate('/splits/new')}
          style={{ display: 'flex', alignItems: 'center', gap: 4, height: 36, padding: '0 14px', borderRadius: 999, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--brand-text)', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>
          <Plus size={15} strokeWidth={2.6} />New split
        </button>} />
      <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560, margin: '0 auto' }}>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ ...card, flex: 1, background: 'color-mix(in srgb, var(--brand) 12%, var(--surface))' }}>
            <div style={{ ...subStyle, color: 'var(--brand-text)' }}>You're owed</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--brand-text)' }}>{data ? money(owedToMe) : '—'}</div>
          </div>
          <div style={{ ...card, flex: 1, background: 'color-mix(in srgb, var(--warning) 14%, var(--surface))' }}>
            <div style={{ ...subStyle, color: 'var(--warning-text)' }}>You owe</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--warning-text)' }}>{data ? money(iOwe) : '—'}</div>
          </div>
        </div>
        <div role="tablist" style={{ display: 'flex', background: 'color-mix(in srgb, var(--text-primary) 7%, transparent)', borderRadius: 14, padding: 4 }}>
          {([['open', 'Open'], ['settled', 'Settled']] as [Tab, string][]).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} type="button" onClick={() => setTab(id)}
              style={{ flex: 1, padding: '9px 0', borderRadius: 11, border: 'none', cursor: 'pointer', fontSize: 13.5, fontWeight: 600,
                background: tab === id ? 'var(--surface)' : 'transparent', color: tab === id ? 'var(--text-primary)' : 'var(--text-secondary)',
                boxShadow: tab === id ? '0 1px 3px rgba(0,0,0,.08)' : 'none' }}>{label}</button>
          ))}
        </div>
        {error ? <div role="alert" style={{ ...card, color: 'var(--danger)', fontWeight: 600, fontSize: 14 }}>{error}</div>
          : !data ? <SplitListSkeleton />
          : rows.length ? <ListCard>{rows.map(r => <div key={r.key}>{r.node}</div>)}</ListCard>
          : (
            <div style={{ ...card, textAlign: 'center', padding: '28px 16px' }}>
              <div style={{ fontSize: 30 }}>🧾</div>
              <div style={{ ...nameStyle, marginTop: 8, whiteSpace: 'normal' }}>{tab === 'open' ? 'No open splits' : 'Nothing settled yet'}</div>
              <p style={{ ...subStyle, marginTop: 4 }}>Paid for a group? Split it - everyone pays you back their share in USDC.</p>
              {tab === 'open' && <button type="button" onClick={() => navigate('/splits/new')} style={{ marginTop: 14, height: 44, padding: '0 20px', borderRadius: 14, border: 'none', background: 'var(--brand)', color: '#fff', fontWeight: 700, fontSize: 14.5, cursor: 'pointer' }}>Split Expense</button>}
            </div>
          )}
      </div>
    </div>
  )
}
