// Admin Panel → System
//
// RPC health   - every Arc and cross-chain RPC endpoint the servers use,
//                checked live: up/down, latency, block height, lag behind
//                the best endpoint of the same chain, rate limits.
// RPC usage    - how many calls the app makes through /api/arc-rpc and how
//                many the proxy makes to providers (it races endpoints, so
//                more), by endpoint and by method, from rpc_usage.
// App errors   - client_errors grouped by message.

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { AdminCard } from '@/components/admin/AdminCard'
import { StatCard } from '@/components/admin/StatCard'
import { chainName, ago, Pill, Chips, Notice, mono } from '@/components/admin/AdminUi'
import {
  adminRpcHealth, adminRpcUsage, adminAppErrors,
  type RpcEndpointHealth, type RpcUsage, type AppErrorGroup, type UsageSum,
} from '@/lib/adminApi'

type Tab = 'health' | 'usage' | 'errors'
type Range = '1h' | '24h' | '7d'

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : '-')
const avgMs = (s: UsageSum) => (s.ok ? `${Math.round(s.latency_ms_total / s.ok)} ms` : '-')
const num = (n: number) => n.toLocaleString()

function healthTone(e: RpcEndpointHealth) {
  if (!e.ok) return { text: e.rateLimited ? 'Rate limited' : 'Down', color: 'var(--danger-text)' }
  if ((e.lag ?? 0) > 5 || e.latencyMs > 2000) return { text: 'Slow', color: 'var(--warning-text)' }
  return { text: 'Healthy', color: 'var(--success-text)' }
}

function Health() {
  const [data, setData] = useState<{ checkedAt: string; endpoints: RpcEndpointHealth[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const check = useCallback(async () => {
    setBusy(true); setErr('')
    try { setData(await adminRpcHealth()) } catch (e) { setErr(e instanceof Error ? e.message : 'Check failed') }
    setBusy(false)
  }, [])
  useEffect(() => { void check() }, [check])

  const chains = data ? [...new Set(data.endpoints.map(e => e.chain))] : []
  const down = data?.endpoints.filter(e => !e.ok).length ?? 0
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13, color: 'var(--text-secondary)' }}>
        {data && <span>{data.endpoints.length} endpoints · {down ? <b style={{ color: 'var(--danger-text)' }}>{down} not answering</b> : 'all answering'} · checked {ago(data.checkedAt)}</span>}
        <button onClick={() => void check()} disabled={busy}
          style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 999, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
          <RefreshCw size={13} /> {busy ? 'Checking…' : 'Check now'}
        </button>
      </div>
      {err && <Notice tone="error">{err}</Notice>}
      {chains.map(chain => (
        <AdminCard key={chain} padding={14}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>{chainName(chain)}</div>
          {data!.endpoints.filter(e => e.chain === chain).map((e, i) => {
            const tone = healthTone(e)
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: 13, flexWrap: 'wrap' }}>
                <span style={{ ...mono, flex: '1 1 220px', minWidth: 0, wordBreak: 'break-all', color: 'var(--text-primary)' }}>
                  {e.label}{e.authenticated && <span style={{ color: 'var(--text-secondary)' }}> · paid key</span>}
                </span>
                <span style={{ color: 'var(--text-secondary)', minWidth: 70 }}>{e.latencyMs} ms</span>
                <span style={{ color: 'var(--text-secondary)', minWidth: 110 }}>
                  {e.ok ? `#${e.block?.toLocaleString()}${e.lag ? ` (−${e.lag})` : ''}` : e.error}
                </span>
                <Pill color={tone.color}>{tone.text}</Pill>
              </div>
            )
          })}
        </AdminCard>
      ))}
    </div>
  )
}

function Bars({ series }: { series: RpcUsage['series'] }) {
  if (!series.length) return null
  const max = Math.max(...series.map(s => s.calls), 1)
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 90 }} role="img" aria-label="App RPC calls over time">
        {series.map(s => (
          <div key={s.key} title={`${new Date(s.key).toLocaleString()}: ${s.calls} calls, ${s.errors} errors`}
            style={{ flex: 1, minWidth: 2, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}>
            <div style={{ height: `${((s.calls - s.errors) / max) * 100}%`, background: 'var(--brand)', borderRadius: '2px 2px 0 0' }} />
            {s.errors > 0 && <div style={{ height: `${(s.errors / max) * 100}%`, background: 'var(--danger)' }} />}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
        <span>{new Date(series[0].key).toLocaleString()}</span><span>{new Date(series[series.length - 1].key).toLocaleString()}</span>
      </div>
    </div>
  )
}

function UsageTable({ title, rows, first }: { title: string; rows: (UsageSum & { key: string })[]; first: string }) {
  return (
    <AdminCard padding={14}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>{title}</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
              <th style={{ textAlign: 'left', padding: '6px 4px' }}>{first}</th>
              <th style={{ padding: '6px 4px' }}>Calls</th><th style={{ padding: '6px 4px' }}>Errors</th>
              <th style={{ padding: '6px 4px' }}>429s</th><th style={{ padding: '6px 4px' }}>Avg</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 25).map(r => (
              <tr key={r.key} style={{ borderTop: '1px solid var(--border)', textAlign: 'right', color: 'var(--text-primary)' }}>
                <td style={{ ...mono, textAlign: 'left', padding: '6px 4px', wordBreak: 'break-all' }}>{r.key}</td>
                <td style={{ padding: '6px 4px' }}>{num(r.calls)}</td>
                <td style={{ padding: '6px 4px', color: r.errors ? 'var(--danger-text)' : undefined }}>{num(r.errors)} <span style={{ color: 'var(--text-secondary)' }}>({pct(r.errors, r.calls)})</span></td>
                <td style={{ padding: '6px 4px', color: r.rate_limited ? 'var(--warning-text)' : undefined }}>{num(r.rate_limited)}</td>
                <td style={{ padding: '6px 4px' }}>{avgMs(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminCard>
  )
}

function Usage({ range }: { range: Range }) {
  const [u, setU] = useState<RpcUsage | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    setU(null); setErr('')
    adminRpcUsage(range).then(setU).catch(e => setErr(e instanceof Error ? e.message : 'Failed to load'))
  }, [range])
  if (err) return <Notice tone="error">{err}</Notice>
  if (!u) return <Notice>Loading…</Notice>
  const c = u.totals.client, up = u.totals.upstream
  if (!c.calls && !up.calls) return <Notice>No RPC calls recorded in this period yet. Counting starts once the updated /api/arc-rpc is live.</Notice>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 }}>
        <StatCard label="App calls" value={num(c.calls)} hint={`${pct(c.errors, c.calls)} failed · avg ${avgMs(c)}`} />
        <StatCard label="Provider calls" value={num(up.calls)} hint={`${(up.calls / Math.max(c.calls, 1)).toFixed(2)}× app calls (racing)`} />
        <StatCard label="Provider errors" value={num(up.errors)} hint={pct(up.errors, up.calls)} accent="var(--danger)" />
        <StatCard label="Rate limited (429)" value={num(up.rate_limited)} hint={pct(up.rate_limited, up.calls)} accent="var(--warning)" />
      </div>
      <AdminCard padding={14}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>App calls over time <span style={{ fontWeight: 500, fontSize: 12, color: 'var(--text-secondary)' }}>(red: failed)</span></div>
        <Bars series={u.series} />
      </AdminCard>
      <UsageTable title="By provider endpoint" rows={u.byEndpoint} first="Endpoint" />
      <UsageTable title="By method (app calls)" rows={u.byMethod} first="Method" />
      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Counts are kept in memory by each server instance and saved every 30 s; a few calls can be lost when an instance shuts down, so treat these as a close minimum.</div>
    </div>
  )
}

function Errors({ range }: { range: Range }) {
  const [d, setD] = useState<{ total: number; groups: AppErrorGroup[] } | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    setD(null); setErr('')
    adminAppErrors(range).then(setD).catch(e => setErr(e instanceof Error ? e.message : 'Failed to load'))
  }, [range])
  if (err) return <Notice tone="error">{err}</Notice>
  if (!d) return <Notice>Loading…</Notice>
  if (!d.groups.length) return <Notice>No app errors in this period.</Notice>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{num(d.total)} errors, {d.groups.length} different</div>
      {d.groups.map((g, i) => (
        <AdminCard key={i} padding={14}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: 'var(--danger-text)', minWidth: 36 }}>{g.count}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', wordBreak: 'break-word' }}>{g.message || '(no message)'}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                {g.kind} · {g.users} user{g.users === 1 ? '' : 's'} · last {ago(g.lastAt)}{g.paths.length ? ` · ${g.paths.join(', ')}` : ''}
              </div>
              {g.builds.length > 0 && <div style={{ ...mono, fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>build {g.builds.join(', ')}</div>}
            </div>
          </div>
        </AdminCard>
      ))}
    </div>
  )
}

export function SystemPage() {
  const [tab, setTab] = useState<Tab>('health')
  const [range, setRange] = useState<Range>('24h')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Chips items={[{ key: 'health', label: 'RPC health' }, { key: 'usage', label: 'RPC usage' }, { key: 'errors', label: 'App errors' }]} value={tab} onChange={setTab} />
      {tab !== 'health' && <Chips items={[{ key: '1h', label: 'Last hour' }, { key: '24h', label: '24 hours' }, { key: '7d', label: '7 days' }]} value={range} onChange={setRange} />}
      {tab === 'health' && <Health />}
      {tab === 'usage' && <Usage range={range} />}
      {tab === 'errors' && <Errors range={range} />}
    </div>
  )
}
