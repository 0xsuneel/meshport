// Admin Panel → Transactions
//
// Every money movement in one place - Pay, Receive, Swap, Cross-chain,
// Claim, Bulk, P2P, Withdraw - read from the user-facing `activity` history
// (with the failure reason the app recorded) and, per transaction, the
// server's own record of it (transaction_intents / attempts), the ledger,
// the chain's answer, and app errors from the user's device around then.
// Read-only: actions on stuck cross-chain moves live in Stuck Funds.

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ExternalLink, RefreshCw, Search, X } from 'lucide-react'
import { AnimatePresence } from 'framer-motion'
import { AdminCard } from '@/components/admin/AdminCard'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { chainName, short, ago, Pill, CopyText, Field, Chips, Notice, mono } from '@/components/admin/AdminUi'
import { explorerTxUrl, arcExplorerTxUrl, ARC_CHAIN_KEY } from '@/lib/chainExplorers'
import { ADMIN_PATH } from '@/lib/adminPath'
import { arcHandle } from '@/lib/userSearch'
import {
  adminTxList, adminTxStats, adminTxDetail,
  type ActivityRow, type TxKind, type TxStatusFilter, type TxStats, type TxDetail, type WalletName,
} from '@/lib/adminApi'

const KINDS: { key: TxKind; label: string }[] = [
  { key: 'pay', label: 'Pay' }, { key: 'receive', label: 'Receive' }, { key: 'swap', label: 'Swap' },
  { key: 'crosschain', label: 'Cross-chain' }, { key: 'claim', label: 'Claim' }, { key: 'bulk', label: 'Bulk' },
  { key: 'p2p', label: 'P2P' }, { key: 'withdraw', label: 'Withdraw' },
]
const KIND_OF_TYPE: Record<string, TxKind> = {
  send: 'pay', receive: 'receive', deposit: 'receive', swap: 'swap', bridge: 'crosschain', claim: 'claim',
  bulk: 'bulk', p2p_sell_order: 'p2p', p2p_refund: 'p2p', p2p_purchase: 'p2p', withdraw: 'withdraw',
}
const kindLabel = (type: string) => KINDS.find(k => k.key === KIND_OF_TYPE[type])?.label ?? type

const STATUS_TONE: Record<string, { text: string; color: string }> = {
  completed: { text: 'Completed', color: 'var(--success-text)' },
  failed: { text: 'Failed', color: 'var(--danger-text)' },
}
const statusTone = (s: string) => STATUS_TONE[s] ?? { text: s ? s[0].toUpperCase() + s.slice(1) : 'Pending', color: 'var(--warning-text)' }

const baseHash = (h?: string | null) => String(h ?? '').replace(/^(send_|recv_)/, '')
const isHash = (h: string) => /^0x[0-9a-fA-F]{64}$/.test(h)
function txLink(chain: string | null | undefined, hash: string): string | null {
  if (!isHash(hash)) return null
  return !chain || chain === ARC_CHAIN_KEY || /arc/i.test(chain) ? arcExplorerTxUrl(hash) : explorerTxUrl(chain, hash)
}
const amountText = (r: ActivityRow) => `${Number(r.amount || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${r.token_symbol ?? 'USDC'}`
const failureText = (r: ActivityRow) => r.metadata?.failure_reason || r.error || ''
const who = (names: Record<string, WalletName>, w?: string | null) => {
  if (!w) return '-'
  const n = names[w.toLowerCase()]
  return n?.username ? arcHandle(n.username) : short(w)
}

// ── Stats header ─────────────────────────────────────────────────────────────
function StatsPanel({ stats, onPick }: { stats: TxStats; onPick: (k: TxKind) => void }) {
  const stuck = Object.entries(stats.stuck_intents)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
        {KINDS.map(k => {
          const c = stats.by_kind[k.key]
          if (!c) return null
          const rate = c.completed + c.failed ? Math.round((c.completed / (c.completed + c.failed)) * 100) : null
          return (
            <AdminCard key={k.key} padding={14} onClick={() => onPick(k.key)}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{k.label}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', marginTop: 4 }}>{c.total}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {rate !== null && <span>{rate}% success</span>}
                {c.failed > 0 && <span style={{ color: 'var(--danger-text)' }}>{c.failed} failed</span>}
                {c.pending > 0 && <span style={{ color: 'var(--warning-text)' }}>{c.pending} pending</span>}
              </div>
            </AdminCard>
          )
        })}
      </div>

      {(stats.failure_reasons.length > 0 || stats.attempt_failures.length > 0 || stuck.length > 0) && (
        <AdminCard padding={16}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>Why transactions failed</div>
          {stats.failure_reasons.map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', padding: '8px 0', borderTop: i ? '1px solid var(--border)' : undefined, fontSize: 13 }}>
              <span style={{ fontWeight: 800, color: 'var(--danger-text)', minWidth: 28 }}>{f.count}</span>
              <span style={{ flex: '1 1 220px', minWidth: 0, color: 'var(--text-primary)' }}>{f.reason || 'No reason recorded'}</span>
              <span style={{ display: 'inline-flex', gap: 8, alignItems: 'baseline', marginLeft: 'auto' }}>
                <Pill color="var(--text-secondary)">{KINDS.find(k => k.key === f.kind)?.label ?? f.kind}</Pill>
                <span style={{ ...mono, fontSize: 11, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>{f.code}</span>
              </span>
            </div>
          ))}
          {stats.attempt_failures.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8, lineHeight: 1.5 }}>
              On-chain attempts:{' '}
              {stats.attempt_failures.map(a => `${a.count} ${a.status.toLowerCase()}${a.code !== '-' ? ` (${a.code})` : ''}`).join(' · ')}
            </div>
          )}
          {stuck.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--warning-text)', marginTop: 6, lineHeight: 1.5 }}>
              In flight over 10 min (server records): {stuck.map(([f, n]) => `${n} ${f}`).join(' · ')} ·{' '}
              <Link to={`${ADMIN_PATH}/stuck-funds`} style={{ color: 'var(--brand-text)' }}>Stuck Funds</Link>
            </div>
          )}
        </AdminCard>
      )}
    </div>
  )
}

// ── Detail ───────────────────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 }}>{title}</div>
      {children}
    </div>
  )
}

function HashField({ label, hash, chain }: { label: string; hash: string; chain?: string | null }) {
  const link = txLink(chain, hash)
  return (
    <Field label={label}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <CopyText value={short(hash, 10)} />
        {link && <a href={link} target="_blank" rel="noopener noreferrer" aria-label="Open in explorer" style={{ color: 'var(--brand-text)', display: 'flex' }}><ExternalLink size={13} /></a>}
      </span>
    </Field>
  )
}

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = useState<TxDetail | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    setD(null); setErr('')
    adminTxDetail(id).then(setD).catch(e => setErr(e instanceof Error ? e.message : 'Failed to load'))
  }, [id])

  const r = d?.row
  const tone = r ? statusTone(r.status) : null
  const hash = r ? baseHash(r.tx_hash) : ''
  const failedHash = String(r?.metadata?.failed_tx_hash ?? '')

  return (
    <DesktopDialogFrame onClose={onClose} maxWidth={620}>
      <div style={{ padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {r && tone && (
              <>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  <Pill color="var(--brand-text)">{kindLabel(r.activity_type)}</Pill>
                  <Pill color={tone.color}>{tone.text}</Pill>
                </div>
                <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)' }}>{amountText(r)}</div>
              </>
            )}
            {!r && !err && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Loading…</div>}
          </div>
          <button onClick={onClose} aria-label="Close"
            style={{ width: 34, height: 34, borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <X size={16} color="var(--text-secondary)" />
          </button>
        </div>

        {err && <div style={{ marginTop: 12 }}><Notice tone="error">{err}</Notice></div>}
        {d && !r && <div style={{ marginTop: 12 }}><Notice>This transaction no longer exists.</Notice></div>}

        {d && r && (
          <>
            {r.status === 'failed' && (
              <div style={{ display: 'flex', gap: 8, marginTop: 12, padding: '10px 12px', borderRadius: 12, fontSize: 13, lineHeight: 1.45,
                color: 'var(--danger-text)', background: 'color-mix(in srgb, var(--danger) 10%, transparent)' }}>
                <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{failureText(r) || 'No reason was recorded'}</div>
                  {r.metadata?.failure_code && <div style={{ ...mono, fontSize: 11, marginTop: 3 }}>code: {r.metadata.failure_code}</div>}
                  {r.error && r.error !== failureText(r) && <div style={{ fontSize: 12, marginTop: 3, wordBreak: 'break-word' }}>{r.error}</div>}
                </div>
              </div>
            )}

            <Section title="Transaction">
              <Field label="From">{who(d.names, r.wallet_address)}</Field>
              <Field label="Wallet"><CopyText value={short(r.wallet_address)} /></Field>
              {r.counterparty_address && <Field label="To / counterparty">{who(d.names, r.counterparty_address)} · <CopyText value={short(r.counterparty_address)} /></Field>}
              <Field label="Chain">{chainName(r.source_chain)}{r.destination_chain && r.destination_chain !== r.source_chain ? ` → ${chainName(r.destination_chain)}` : ''}</Field>
              {isHash(hash) && <HashField label="Tx hash" hash={hash} chain={r.source_chain} />}
              {r.destination_tx_hash && isHash(r.destination_tx_hash) && <HashField label="Destination tx" hash={r.destination_tx_hash} chain={r.destination_chain} />}
              {isHash(failedHash) && failedHash !== hash && <HashField label="Failed tx" hash={failedHash} chain={r.source_chain} />}
              <Field label="Time">{new Date(r.created_at).toLocaleString()} · {ago(r.created_at)}</Field>
              {d.twin && <Field label="Other side">{who(d.names, d.twin.wallet_address)}'s copy: {statusTone(d.twin.status).text}</Field>}
            </Section>

            {d.chain && (
              <Section title="On-chain (Arc, live)">
                {d.chain.found === null && <Notice>Couldn't reach the Arc network to check.</Notice>}
                {d.chain.found === false && <Notice>Not on chain - no receipt for this hash.</Notice>}
                {d.chain.found && (
                  <>
                    <Field label="Result"><span style={{ color: d.chain.status === 'success' ? 'var(--success-text)' : 'var(--danger-text)' }}>{d.chain.status === 'success' ? 'Succeeded' : 'Reverted'}</span></Field>
                    <Field label="Block">{d.chain.block?.toLocaleString()}</Field>
                    <Field label="Gas used">{d.chain.gasUsed?.toLocaleString()}</Field>
                  </>
                )}
              </Section>
            )}

            <Section title="Server record">
              {!d.intents.length && <Notice>No server record. This one didn't go through MeshPort's servers (for example a receive from outside, or a payment the app sent straight to the chain).</Notice>}
              {d.intents.map(it => (
                <div key={it.id}>
                  <Field label="Flow">{it.feature}{it.operation ? ` · ${it.operation}` : ''}</Field>
                  <Field label="Status">{it.status}</Field>
                  <Field label="Created → updated">{new Date(it.created_at).toLocaleTimeString()} → {new Date(it.updated_at).toLocaleTimeString()}{it.completed_at ? ` · done ${new Date(it.completed_at).toLocaleTimeString()}` : ''}</Field>
                  {(it.failure_code || it.failure_message) && <Field label="Failure"><span style={{ color: 'var(--danger-text)' }}>{[it.failure_code, it.failure_message].filter(Boolean).join(': ')}</span></Field>}
                </div>
              ))}
              {d.attempts.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {d.attempts.map((a, i) => (
                    <div key={a.id} style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid var(--border)', fontSize: 12, lineHeight: 1.5 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <b style={{ color: 'var(--text-primary)' }}>Attempt {i + 1}</b>
                        <Pill color={a.status === 'CONFIRMED' ? 'var(--success-text)' : ['REVERTED', 'DROPPED'].includes(a.status) ? 'var(--danger-text)' : 'var(--warning-text)'}>{a.status}</Pill>
                        <span style={{ color: 'var(--text-secondary)' }}>{chainName(a.chain_id)}{a.nonce != null ? ` · nonce ${a.nonce}` : ''}{a.block_number ? ` · block ${a.block_number}` : ''}</span>
                      </div>
                      {a.tx_hash && <div style={{ ...mono, color: 'var(--text-secondary)' }}>{short(a.tx_hash, 10)}</div>}
                      {(a.failure_code || a.failure_message) && <div style={{ color: 'var(--danger-text)' }}>{[a.failure_code, a.failure_message].filter(Boolean).join(': ')}</div>}
                      <div style={{ color: 'var(--text-secondary)' }}>
                        {a.submitted_at ? `sent ${new Date(a.submitted_at).toLocaleTimeString()}` : 'not sent'}
                        {a.confirmed_at ? ` · confirmed ${new Date(a.confirmed_at).toLocaleTimeString()}` : ''}
                        {a.gas_used ? ` · gas ${Number(a.gas_used).toLocaleString()}` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {d.ledger.length > 0 && (
              <Section title="Ledger">
                {d.ledger.map(l => (
                  <Field key={l.id} label={`${l.event_type} · ${l.direction}`}>
                    {(Number(l.amount_atomic) / 10 ** l.decimals).toLocaleString(undefined, { maximumFractionDigits: 6 })} {l.token_symbol ?? ''} · {l.settlement_status}
                  </Field>
                ))}
              </Section>
            )}

            <Section title="App errors from this user (±5 min)">
              {!d.appErrors.length ? <Notice>None recorded.</Notice> : d.appErrors.map((e, i) => (
                <div key={i} style={{ padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: 12, lineHeight: 1.45 }}>
                  <div style={{ color: 'var(--danger-text)', wordBreak: 'break-word' }}>{e.message}</div>
                  <div style={{ color: 'var(--text-secondary)' }}>{new Date(e.created_at).toLocaleTimeString()} · {e.kind}{e.path ? ` · ${e.path}` : ''}{e.build ? ` · build ${e.build}` : ''}</div>
                </div>
              ))}
            </Section>

            <details style={{ marginTop: 14 }}>
              <summary style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', cursor: 'pointer' }}>Raw record</summary>
              <pre style={{ ...mono, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--text-secondary)', marginTop: 8 }}>
                {JSON.stringify({ activity: r, intents: d.intents }, null, 2)}
              </pre>
            </details>
          </>
        )}
      </div>
    </DesktopDialogFrame>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────
type Range = '24h' | '7d' | '30d'

export function TransactionsPage() {
  const [range, setRange] = useState<Range>('24h')
  const [stats, setStats] = useState<TxStats | null>(null)
  const [kind, setKind] = useState<'all' | TxKind>('all')
  const [status, setStatus] = useState<'all' | TxStatusFilter>('all')
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<ActivityRow[]>([])
  const [names, setNames] = useState<Record<string, WalletName>>({})
  const [next, setNext] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const from = useCallback(() => new Date(Date.now() - { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 }[range]).toISOString(), [range])

  const load = useCallback(async (before: string | null = null) => {
    setLoading(true); setErr('')
    try {
      const res = await adminTxList({
        kind: kind === 'all' ? null : kind, status: status === 'all' ? null : status,
        q: query, from: query ? undefined : from(), before, limit: 50,
      })
      setRows(prev => (before ? [...prev, ...res.rows] : res.rows))
      setNames(prev => (before ? { ...prev, ...res.names } : res.names))
      setNext(res.next)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load') }
    setLoading(false)
  }, [kind, status, query, from])

  useEffect(() => { void load() }, [load])
  useEffect(() => { adminTxStats(range).then(setStats).catch(() => setStats(null)) }, [range])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Chips items={[{ key: '24h', label: 'Last 24h' }, { key: '7d', label: '7 days' }, { key: '30d', label: '30 days' }]} value={range} onChange={setRange} />
        <button onClick={() => { void load(); adminTxStats(range).then(setStats).catch(() => {}) }} disabled={loading}
          style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 999, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {stats && <StatsPanel stats={stats} onPick={k => setKind(k)} />}

      <AdminCard padding={14} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <form onSubmit={e => { e.preventDefault(); setQuery(q.trim()) }} style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--bg)' }}>
            <Search size={15} color="var(--text-secondary)" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Username, wallet address or tx hash"
              style={{ flex: 1, minWidth: 0, height: 40, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text-primary)', fontSize: 14 }} />
            {q && <button type="button" aria-label="Clear" onClick={() => { setQ(''); setQuery('') }} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex' }}><X size={15} color="var(--text-secondary)" /></button>}
          </div>
          <button type="submit" style={{ padding: '0 16px', borderRadius: 12, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Search</button>
        </form>
        <Chips items={[{ key: 'all' as const, label: 'All' }, ...KINDS]} value={kind} onChange={setKind} />
        <Chips items={[{ key: 'all', label: 'Any status' }, { key: 'completed', label: 'Completed' }, { key: 'failed', label: 'Failed' }, { key: 'pending', label: 'Pending' }]} value={status} onChange={setStatus} />
        {query && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Showing all dates for "{query}"</div>}
      </AdminCard>

      {err && <Notice tone="error">{err}</Notice>}
      {!err && !loading && rows.length === 0 && <Notice>No transactions match.</Notice>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map(r => {
          const tone = statusTone(r.status)
          const reason = r.status === 'failed' ? failureText(r) : ''
          return (
            <AdminCard key={r.id} padding={14} onClick={() => setOpen(r.id)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Pill color="var(--brand-text)">{kindLabel(r.activity_type)}</Pill>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {who(names, r.wallet_address)}{r.counterparty_address ? ` → ${who(names, r.counterparty_address)}` : ''}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                    {chainName(r.source_chain)}{r.destination_chain && r.destination_chain !== r.source_chain ? ` → ${chainName(r.destination_chain)}` : ''} · {ago(r.created_at)}
                  </div>
                  {reason && <div style={{ fontSize: 12, color: 'var(--danger-text)', marginTop: 4, wordBreak: 'break-word' }}>{reason}</div>}
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-primary)' }}>{amountText(r)}</div>
                  <div style={{ marginTop: 4 }}><Pill color={tone.color}>{tone.text}</Pill></div>
                </div>
              </div>
            </AdminCard>
          )
        })}
      </div>

      {next && (
        <button onClick={() => void load(next)} disabled={loading}
          style={{ alignSelf: 'center', padding: '9px 18px', borderRadius: 999, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}

      <AnimatePresence>{open && <Detail key={open} id={open} onClose={() => setOpen(null)} />}</AnimatePresence>
    </div>
  )
}
