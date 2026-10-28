// Admin Panel → System
//
// RPC health   - every Arc and cross-chain RPC endpoint the servers use,
//                checked live: up/down, latency, block height, lag behind
//                the best endpoint of the same chain, rate limits.
// RPC usage    - how many calls the app makes through /api/arc-rpc and how
//                many the proxy makes to providers (it races endpoints, so
//                more), by endpoint and by method, from rpc_usage.
// App errors   - client_errors grouped by message.

import React, { useCallback, useEffect, useState } from 'react'
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

/** "What am I looking at" box at the top of each tab. */
function Explain({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details open style={{ borderRadius: 14, background: 'color-mix(in srgb, var(--brand) 6%, var(--surface))', border: '1px solid var(--border)' }}>
      <summary style={{ padding: '10px 14px', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', cursor: 'pointer' }}>{title}</summary>
      <div style={{ padding: '0 14px 12px', fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)' }}>{children}</div>
    </details>
  )
}

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
      <Explain title="What is RPC health?">
        An <b>RPC endpoint</b> is a provider's server that MeshPort uses to read a blockchain and send transactions to it. Every chain has
        several, so if one fails the next is used automatically. This checks each one live, from MeshPort's servers, by asking for its chain
        id and newest block.
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          <li><b>Speed</b>: how long it took to answer (under 1 s is good).</li>
          <li><b>Latest block</b>: the newest block it knows. <b>(−7)</b> means 7 blocks behind the best provider of that chain, so its data is a bit old.</li>
          <li><b>Paid key</b>: our own account with that provider (higher limits). <b>Public</b>: free and shared with everyone, so it gets rate-limited first.</li>
          <li><b>Healthy</b> = fine. <b>Slow</b> = over 2 s or more than 5 blocks behind. <b>Rate limited</b> = the provider is refusing because of too many requests (429). <b>Down</b> = no answer.</li>
        </ul>
        One endpoint down is normal; worry when every endpoint of a chain is down or slow - then that chain's payments fail.
      </Explain>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13, color: 'var(--text-secondary)' }}>
        {data && <span>{data.endpoints.length} endpoints · {down ? <b style={{ color: 'var(--danger-text)' }}>{down} not answering</b> : 'all answering'} · checked {ago(data.checkedAt)}</span>}
        <button onClick={() => void check()} disabled={busy}
          style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 999, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
          <RefreshCw size={13} /> {busy ? 'Checking…' : 'Check now'}
        </button>
      </div>
      {err && <Notice tone="error">{err}</Notice>}
      {chains.map(chain => {
        const eps = data!.endpoints.filter(e => e.chain === chain)
        const up = eps.filter(e => e.ok)
        const fastest = up.length ? up.reduce((a, b) => (a.latencyMs <= b.latencyMs ? a : b)) : null
        return (
        <AdminCard key={chain} padding={14}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{chainName(chain)}</span>
            <span style={{ fontSize: 12, color: up.length ? 'var(--text-secondary)' : 'var(--danger-text)', fontWeight: up.length ? 400 : 700 }}>
              {up.length ? `${up.length} of ${eps.length} answering · fastest ${fastest!.label} (${fastest!.latencyMs} ms)` : 'No endpoint answering - this chain\u2019s payments will fail'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 10, padding: '6px 0', fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.3 }}>
            <span style={{ flex: '1 1 220px' }}>Endpoint</span><span style={{ minWidth: 70 }}>Speed</span><span style={{ minWidth: 110 }}>Latest block</span><span style={{ minWidth: 80 }}>Status</span>
          </div>
          {eps.map((e, i) => {
            const tone = healthTone(e)
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: 13, flexWrap: 'wrap' }}>
                <span style={{ ...mono, flex: '1 1 220px', minWidth: 0, wordBreak: 'break-all', color: 'var(--text-primary)' }}>
                  {e.label} <span style={{ color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 11 }}>· {e.authenticated ? 'paid key' : 'public'}</span>
                </span>
                <span style={{ color: 'var(--text-secondary)', minWidth: 70 }}>{e.latencyMs} ms</span>
                <span style={{ color: 'var(--text-secondary)', minWidth: 110 }}>
                  {e.ok ? `#${e.block?.toLocaleString()}${e.lag ? ` (−${e.lag})` : ''}` : e.error}
                </span>
                <span style={{ minWidth: 80 }}><Pill color={tone.color}>{tone.text}</Pill></span>
              </div>
            )
          })}
        </AdminCard>
        )
      })}
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

function UsageTable({ title, note, rows, first }: { title: string; note?: string; rows: (UsageSum & { key: string })[]; first: string }) {
  return (
    <AdminCard padding={14}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: note ? 2 : 6 }}>{title}</div>
      {note && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6, lineHeight: 1.5 }}>{note}</div>}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
              <th style={{ textAlign: 'left', padding: '6px 4px' }}>{first}</th>
              <th style={{ padding: '6px 4px' }}>Requests</th><th style={{ padding: '6px 4px' }}>Failed</th>
              <th style={{ padding: '6px 4px' }}>Rate limited</th><th style={{ padding: '6px 4px' }}>Avg time</th>
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
  const explain = (
    <Explain title="What is RPC usage?">
      How much MeshPort uses the Arc blockchain's providers. Every Arc request from the app goes through MeshPort's own proxy
      (<code>/api/arc-rpc</code>), which picks the healthiest provider and, if it's slow, also asks a second one - so providers receive more
      requests than the app sends.
      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
        <li><b>Requests from the app</b>: what users' phones asked for (balances, sending a payment, checking a receipt…).</li>
        <li><b>Requests to providers</b>: what the proxy actually sent - this is what provider plans count and bill.</li>
        <li><b>Failed</b>: the request got no usable answer. <b>Rate limited (429)</b>: a provider refused because of too many requests - mostly the free public endpoints; a paid key fixes it.</li>
        <li><b>Avg</b>: average time for a successful answer.</li>
      </ul>
      Counted for Arc only (other chains and background workers aren't counted yet). Counts are saved every 30 s, so a few calls can be missed - treat them as a close minimum.
    </Explain>
  )
  if (!c.calls && !up.calls) return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{explain}<Notice>No RPC calls recorded in this period yet.</Notice></div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {explain}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 }}>
        <StatCard label="Requests from the app" value={num(c.calls)} hint={`${pct(c.errors, c.calls)} failed · avg ${avgMs(c)}`} />
        <StatCard label="Requests to providers" value={num(up.calls)} hint={`${(up.calls / Math.max(c.calls, 1)).toFixed(2)} per app request`} />
        <StatCard label="Provider failures" value={num(up.errors)} hint={`${pct(up.errors, up.calls)} of provider requests`} accent="var(--danger)" />
        <StatCard label="Rate limited (429)" value={num(up.rate_limited)} hint={`${pct(up.rate_limited, up.calls)} - too many requests`} accent="var(--warning)" />
      </div>
      <AdminCard padding={14}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>Requests from the app over time <span style={{ fontWeight: 500, fontSize: 12, color: 'var(--text-secondary)' }}>(each bar = 5 min · red = failed)</span></div>
        <Bars series={u.series} />
      </AdminCard>
      <UsageTable title="Each provider" note="Requests the proxy sent to each provider. A high error or 429 share means that provider is struggling or limiting us." rows={u.byEndpoint} first="Provider" />
      <UsageTable title="What the app asked for" note="eth_call = read a contract · eth_getBalance = a balance · eth_getTransactionReceipt = did a payment confirm · eth_estimateGas = fee estimate · meshport_sendRawTransactionAndWait = send a payment." rows={u.byMethod} first="Request type" />
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
  const explain = (
    <Explain title="What are app errors?">
      Crashes and unhandled errors from users' phones and browsers, grouped by message. The number on the left is how often it happened;
      "users" is how many different accounts hit it; the page and app version (build) show where. A transaction's own failure reason
      (e.g. "not enough balance") is on the Transactions page, not here - this is for bugs.
    </Explain>
  )
  if (!d.groups.length) return <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{explain}<Notice>No app errors in this period.</Notice></div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {explain}
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
