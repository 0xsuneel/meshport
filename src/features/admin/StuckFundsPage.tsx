// Admin Panel → Stuck Funds
//
// The admin fallback for cross-chain moves a user couldn't finish in their
// own Recover tab. Users always come first (they can finish everything with
// their own wallet); this page is for when they can't.
//
// Hard rule: nothing here can change where money goes. Wallet, destination
// chain and destination address are display-only, and every action sends a
// row id only (see lib/adminRecovery.ts). Every action is audit-logged.

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import {
  AlertTriangle, ArrowRight, Bell, Check, Copy, ExternalLink, Lock, RefreshCw, Search, ShieldCheck, X, Zap, Clock, RotateCcw,
} from 'lucide-react'
import { AdminCard } from '@/components/admin/AdminCard'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { copyToClipboard } from '@/lib/utils'
import { explorerTxUrl, arcExplorerTxUrl } from '@/lib/chainExplorers'
import {
  adminListStuck, adminInspect, adminFinishClaim, adminReattest, adminRelayTransfer, adminRequeueUbClaim,
  adminNotifyUser, fetchRecoveryLog, type StuckItem, type StuckKind, type AdminActionResult, type RecoveryLogRow,
} from '@/lib/adminRecovery'

// ── Presentation helpers ─────────────────────────────────────────────────────
const KIND_META: Record<StuckKind, { label: string; short: string; tone: string }> = {
  claim:         { label: 'CCTP claim',     short: 'Bring · CCTP',    tone: 'var(--brand)' },
  transfer:      { label: 'CCTP transfer',  short: 'Transfer · CCTP', tone: '#6C8CFF' },
  ub_transfer:   { label: 'UB transfer',    short: 'Transfer · UB',   tone: 'var(--warning)' },
  ub_claim:      { label: 'UB claim',       short: 'Bring · UB',      tone: '#B98CFF' },
  ub_withdrawal: { label: 'UB withdrawal',  short: '7-day withdrawal', tone: 'var(--text-secondary)' },
}

const FILTERS: Array<{ key: 'all' | StuckKind; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'claim', label: 'CCTP claims' },
  { key: 'transfer', label: 'CCTP transfers' },
  { key: 'ub_transfer', label: 'UB transfers' },
  { key: 'ub_claim', label: 'UB claims' },
  { key: 'ub_withdrawal', label: 'Withdrawals' },
]

const STATE_TEXT: Record<string, string> = {
  already_minted: 'Funds already arrived — the record is now marked completed.',
  waiting_attestation: 'Circle has not attested this burn yet. It finishes on its own.',
  ready_relay: 'Ready — the MeshPort relayer can mint this on Arc.',
  ready_self_mint: 'Ready — can be minted on the destination (by the user, or the MeshPort relayer).',
  forwarder_only: 'Locked to Circle’s forwarder — only Circle can finish it. Nothing to do but wait.',
  needs_reattest: 'The attestation expired. Request a new one, then check again.',
  no_message: 'Circle has no record of this burn.',
  unsupported_chain: 'This chain is not supported for recovery.',
  relay_queued: 'Queued — the MeshPort relayer will mint on Arc within a few minutes.',
  reattest_requested: 'New attestation requested. Check again in a few minutes.',
  reattest_failed: 'Circle rejected the re-attestation request. Try again later.',
  requeued: 'Resubmitted — ub-claim-worker will retry it within a minute.',
  notified: 'The user was notified in the app.',
}

const chainName = (c?: string | null) =>
  !c ? '—' : c === 'Arc_Testnet' ? 'Arc' : c.replace(/_(Sepolia|Testnet|Fuji|Apothem|Amoy_Testnet)$/, '').replace(/_/g, ' ')
const short = (a?: string | null, n = 6) => (!a ? '—' : a.length > 2 * n + 2 ? `${a.slice(0, n)}…${a.slice(-4)}` : a)
const usd = (n: number) => `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`
function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
function txUrl(item: StuckItem): string | null {
  if (!item.txHash) return null
  // Claims burn/deposit on the source chain; transfers and UB deposits start on Arc.
  const chain = item.kind === 'claim' || item.kind === 'ub_claim' ? item.from
    : item.kind === 'ub_withdrawal' ? item.from : 'Arc_Testnet'
  return chain === 'Arc_Testnet' ? arcExplorerTxUrl(item.txHash) : explorerTxUrl(chain === 'Polygon_Amoy_Testnet' ? 'Polygon_Sepolia' : chain, item.txHash)
}
function statusTone(item: StuckItem): { text: string; color: string } {
  if (item.kind === 'ub_transfer') return { text: 'Waiting for user', color: 'var(--warning)' }
  if (item.kind === 'ub_withdrawal') return { text: 'Withdrawing', color: 'var(--text-secondary)' }
  if (item.status === 'failed' || item.status === 'expired') return { text: item.status === 'expired' ? 'Expired' : 'Failed', color: 'var(--danger)' }
  return { text: 'Stuck in progress', color: 'var(--warning)' }
}

// ── Small UI pieces ──────────────────────────────────────────────────────────
function Pill({ children, color }: { children: ReactNode; color: string }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 999, whiteSpace: 'nowrap',
      color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>{children}</span>
  )
}

function CopyText({ value, mono = true }: { value: string; mono?: boolean }) {
  const [done, setDone] = useState(false)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <span style={{ fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined, wordBreak: 'break-all' }}>{value}</span>
      <button aria-label="Copy" onClick={e => { e.stopPropagation(); copyToClipboard(value).then(ok => { if (ok) { setDone(true); setTimeout(() => setDone(false), 1200) } }) }}
        style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex', flexShrink: 0 }}>
        {done ? <Check size={13} color="var(--success)" /> : <Copy size={13} />}
      </button>
    </span>
  )
}

function Field({ label, children, locked }: { label: string; children: ReactNode; locked?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, padding: '10px 0', borderTop: '1px solid var(--border)', fontSize: 13 }}>
      <span style={{ color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
        {locked && <Lock size={12} aria-label="Locked" />}{label}
      </span>
      <span style={{ color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right', minWidth: 0 }}>{children}</span>
    </div>
  )
}

function ActionButton({ children, onClick, disabled, primary, icon }: {
  children: ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean; icon?: ReactNode
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 42, padding: '0 14px',
        borderRadius: 12, fontSize: 13, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
        background: primary ? 'var(--brand)' : 'transparent', color: primary ? '#fff' : 'var(--text-primary)',
        border: primary ? 'none' : '1px solid var(--border)', flex: '1 1 auto',
      }}>
      {icon}{children}
    </button>
  )
}

// ── Detail panel ─────────────────────────────────────────────────────────────
function Detail({ item, relayerConfigured, onClose, onChanged }: {
  item: StuckItem; relayerConfigured: boolean; onClose: () => void; onChanged: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [diag, setDiag] = useState<AdminActionResult | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { setDiag(null); setErr('') }, [item.id])

  const run = async (key: string, confirmText: string | null, fn: () => Promise<AdminActionResult>, refresh = false) => {
    if (confirmText && !window.confirm(confirmText)) return
    setBusy(key); setErr('')
    try {
      const r = await fn()
      if (r?.error) setErr(r.error)
      setDiag(r)
      if (refresh) onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
    setBusy(null)
  }

  const meta = KIND_META[item.kind]
  const tone = statusTone(item)
  const cctpKind = item.kind === 'claim' || item.kind === 'transfer' ? item.kind : null
  const state = diag?.state
  const link = txUrl(item)
  const who = item.username ? `@${item.username}` : 'Unknown user'

  return (
    <AdminCard padding={18} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <Pill color={meta.tone}>{meta.label}</Pill>
            <Pill color={tone.color}>{tone.text}</Pill>
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.4px' }}>{usd(item.amount)}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
            {chainName(item.from)} <ArrowRight size={14} color="var(--text-secondary)" /> {chainName(item.to)}
          </div>
        </div>
        <button onClick={onClose} aria-label="Close"
          style={{ width: 34, height: 34, borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <X size={16} color="var(--text-secondary)" />
        </button>
      </div>

      <div>
        <Field label="User">{who}</Field>
        <Field label="Wallet" locked><CopyText value={item.wallet} /></Field>
        <Field label="From chain" locked>{chainName(item.from)}</Field>
        <Field label="Destination chain" locked>{chainName(item.to)}</Field>
        <Field label="Destination address" locked>{item.destinationAddress ? <CopyText value={item.destinationAddress} /> : '—'}</Field>
        {item.txHash && (
          <Field label={item.kind === 'claim' ? 'Burn tx' : item.kind === 'ub_withdrawal' ? 'Withdrawal tx' : 'Deposit / burn tx'}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <CopyText value={short(item.txHash, 10)} />
              {link && <a href={link} target="_blank" rel="noopener noreferrer" aria-label="Open in explorer" style={{ color: 'var(--brand)', display: 'flex' }}><ExternalLink size={13} /></a>}
            </span>
          </Field>
        )}
        <Field label="Started">{new Date(item.createdAt).toLocaleString()} · {ago(item.createdAt)}</Field>
        {item.readyAt && <Field label="Returns to user">{new Date(item.readyAt).toLocaleString()}</Field>}
        {typeof item.attempts === 'number' && item.kind === 'ub_claim' && <Field label="Server attempts">{item.attempts}</Field>}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 12, fontSize: 12, lineHeight: 1.45,
        color: 'var(--text-secondary)', background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)' }}>
        <Lock size={13} style={{ flexShrink: 0, marginTop: 1 }} />
        Wallet, destination chain and destination address are locked. Admin actions only finish the move exactly as the user confirmed it.
      </div>

      {item.error && (
        <div style={{ display: 'flex', gap: 8, padding: '10px 12px', borderRadius: 12, fontSize: 12.5, lineHeight: 1.45,
          color: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 10%, transparent)' }}>
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <span style={{ wordBreak: 'break-word' }}>{item.error}</span>
        </div>
      )}

      {(state || err) && (
        <div style={{ padding: '10px 12px', borderRadius: 12, fontSize: 13, lineHeight: 1.45,
          background: err ? 'color-mix(in srgb, var(--danger) 10%, transparent)' : 'color-mix(in srgb, var(--brand) 10%, transparent)',
          color: err ? 'var(--danger)' : 'var(--text-primary)' }}>
          {err || (state ? STATE_TEXT[state] ?? state : '')}
          {!err && diag?.detail && state !== 'notified' && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{diag.detail}</div>}
          {!err && diag?.destinationMintTxHash && <div style={{ fontSize: 12, marginTop: 4 }}>Mint tx: <CopyText value={short(diag.destinationMintTxHash, 10)} /></div>}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {cctpKind && (
          <ActionButton icon={<RefreshCw size={14} />} disabled={!!busy} onClick={() => run('inspect', null, () => adminInspect(cctpKind, item.id), true)}>
            {busy === 'inspect' ? 'Checking…' : 'Check status'}
          </ActionButton>
        )}
        {item.kind === 'claim' && state === 'ready_relay' && (
          <ActionButton primary icon={<Zap size={14} />} disabled={!!busy}
            onClick={() => run('finish', `Mint ${usd(item.amount)} on Arc to ${short(item.wallet)} with the MeshPort relayer?`, () => adminFinishClaim(item.id), true)}>
            {busy === 'finish' ? 'Queuing…' : 'Finish on Arc (relayer)'}
          </ActionButton>
        )}
        {item.kind === 'transfer' && state === 'ready_self_mint' && (
          <ActionButton primary icon={<Zap size={14} />} disabled={!!busy || !relayerConfigured}
            onClick={() => run('relay', `Mint on ${chainName(item.to)} with the MeshPort relayer? Funds go to the address inside the signed message${item.destinationAddress ? ` (${short(item.destinationAddress)})` : ''}; the relayer only pays gas.`, () => adminRelayTransfer(item.id), true)}>
            {busy === 'relay' ? 'Minting…' : relayerConfigured ? `Mint on ${chainName(item.to)} (relayer)` : 'Relayer not configured'}
          </ActionButton>
        )}
        {cctpKind && state === 'needs_reattest' && (
          <ActionButton icon={<RotateCcw size={14} />} disabled={!!busy} onClick={() => run('reattest', null, () => adminReattest(cctpKind, item.id))}>
            {busy === 'reattest' ? 'Requesting…' : 'Request new attestation'}
          </ActionButton>
        )}
        {item.kind === 'ub_claim' && (
          <ActionButton primary icon={<RotateCcw size={14} />} disabled={!!busy}
            onClick={() => run('requeue', `Resubmit the user's signed claim to Circle? It mints to ${short(item.wallet)} on Arc — the same wallet the user signed for.`, () => adminRequeueUbClaim(item.id), true)}>
            {busy === 'requeue' ? 'Resubmitting…' : 'Resubmit to Circle'}
          </ActionButton>
        )}
        <ActionButton icon={<Bell size={14} />} disabled={!!busy}
          onClick={() => run('notify', `Send ${who} an in-app notification asking them to finish this in Recover?`, () => adminNotifyUser(item.kind, item.id))}>
          {busy === 'notify' ? 'Sending…' : 'Notify user'}
        </ActionButton>
      </div>

      {(item.kind === 'ub_transfer' || item.kind === 'ub_withdrawal') && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {item.kind === 'ub_transfer'
            ? 'Unified Balance funds can only be moved with the user’s own signature. The user finishes this in Multichain Hub → Recover (send to the saved destination, back to their wallet, or the 7-day withdrawal). Notify them if they haven’t.'
            : 'This 7-day on-chain withdrawal completes automatically the next time the user opens the app after the return date. No admin action is possible or needed.'}
        </div>
      )}
      {cctpKind && !state && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          Check status reads Circle’s attestation service and the destination chain directly, then shows what can be done. The user can also finish this themselves in Recover.
        </div>
      )}
    </AdminCard>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────
export function StuckFundsPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const [items, setItems] = useState<StuckItem[]>([])
  const [relayerConfigured, setRelayerConfigured] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<'all' | StuckKind>('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [log, setLog] = useState<RecoveryLogRow[]>([])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const r = await adminListStuck()
      setItems(r.items ?? [])
      setRelayerConfigured(!!r.relayerConfigured)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    fetchRecoveryLog().then(setLog).catch(() => {})
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length }
    for (const i of items) c[i.kind] = (c[i.kind] ?? 0) + 1
    return c
  }, [items])
  const totalUsd = useMemo(() => items.filter(i => i.kind !== 'ub_withdrawal').reduce((s, i) => s + i.amount, 0), [items])
  const usersAffected = useMemo(() => new Set(items.map(i => i.wallet)).size, [items])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter(i => (filter === 'all' || i.kind === filter) && (!q ||
      i.wallet.includes(q) || (i.username ?? '').toLowerCase().includes(q) || (i.txHash ?? '').toLowerCase().includes(q) ||
      (i.destinationAddress ?? '').toLowerCase().includes(q) || i.id.includes(q)))
  }, [items, filter, query])

  const selected = items.find(i => i.id === selectedId) ?? null

  const tile = (label: string, value: string, sub?: string, color = 'var(--text-primary)') => (
    <AdminCard padding={14} style={{ flex: '1 1 150px' }}>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color, marginTop: 4, letterSpacing: '-0.4px' }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>{sub}</div>}
    </AdminCard>
  )

  const list = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {visible.map(item => {
        const meta = KIND_META[item.kind]
        const tone = statusTone(item)
        const active = item.id === selectedId
        return (
          <AdminCard key={`${item.kind}:${item.id}`} padding={14} onClick={() => setSelectedId(item.id)}
            style={{ border: active ? '1.5px solid var(--brand)' : '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 8, alignSelf: 'stretch', borderRadius: 4, background: meta.tone, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                  <span>{chainName(item.from)}</span><ArrowRight size={13} color="var(--text-secondary)" /><span>{chainName(item.to)}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {item.username ? `@${item.username}` : short(item.wallet)} · {meta.short} · {ago(item.createdAt)}
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-primary)' }}>{usd(item.amount)}</div>
                <div style={{ marginTop: 4 }}><Pill color={tone.color}>{tone.text}</Pill></div>
              </div>
            </div>
          </AdminCard>
        )
      })}
    </div>
  )

  const chip = (active: boolean): CSSProperties => ({
    padding: '7px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
    background: active ? 'var(--brand)' : 'var(--surface)', color: active ? '#fff' : 'var(--text-secondary)', border: '1px solid var(--border)',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Intro */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px' }}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            Cross-chain moves that didn’t finish, across all users. Users can finish every one of these themselves in Recover —
            use this page when they can’t. Destinations are locked and every action is logged.
          </div>
        </div>
        <button onClick={() => void load()} disabled={loading}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 40, padding: '0 14px', borderRadius: 12, fontSize: 13, fontWeight: 700,
            border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)', cursor: 'pointer' }}>
          <RefreshCw size={14} /> {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* Summary */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {tile('Stuck moves', String(counts.all ?? 0), `${usersAffected} user${usersAffected === 1 ? '' : 's'} affected`, (counts.all ?? 0) > 0 ? 'var(--warning)' : 'var(--success)')}
        {tile('USDC not yet delivered', usd(totalUsd), 'Excludes 7-day withdrawals')}
        {tile('Waiting for users', String(counts.ub_transfer ?? 0), 'UB transfers — user must choose')}
        {tile('Relayer', relayerConfigured ? 'Ready' : 'Not set', relayerConfigured ? 'Can finish CCTP mints' : 'Set RELAYER_PRIVATE_KEY', relayerConfigured ? 'var(--success)' : 'var(--danger)')}
      </div>

      {/* Filters + search */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', flex: '1 1 420px', paddingBottom: 2 }}>
          {FILTERS.map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)} style={chip(filter === f.key)}>
              {f.label} ({counts[f.key] ?? 0})
            </button>
          ))}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 240px', minHeight: 40, padding: '0 12px', borderRadius: 12,
          border: '1px solid var(--border)', background: 'var(--surface)' }}>
          <Search size={14} color="var(--text-secondary)" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search user, wallet or tx hash"
            aria-label="Search stuck funds"
            style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: 13 }} />
        </label>
      </div>

      {error && <AdminCard><div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div></AdminCard>}

      {!loading && !error && visible.length === 0 ? (
        <AdminCard>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '28px 0', gap: 8 }}>
            <ShieldCheck size={30} color="var(--success)" />
            <p style={{ color: 'var(--text-primary)', fontSize: 14, fontWeight: 700, margin: 0 }}>Nothing stuck</p>
            <p style={{ color: 'var(--text-secondary)', fontSize: 12.5, margin: 0 }}>Every cross-chain move in this view has finished.</p>
          </div>
        </AdminCard>
      ) : isDesktop ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 440px)', gap: 16, alignItems: 'start' }}>
          {list}
          <div style={{ position: 'sticky', top: 16 }}>
            {selected
              ? <Detail item={selected} relayerConfigured={relayerConfigured} onClose={() => setSelectedId(null)} onChanged={() => void load()} />
              : <AdminCard><div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: '18px 0', textAlign: 'center' }}>Select a move to see its details and actions.</div></AdminCard>}
          </div>
        </div>
      ) : (
        <>
          {list}
          {selected && (
            <div role="dialog" aria-modal="true" onClick={() => setSelectedId(null)}
              style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end' }}>
              <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxHeight: '88dvh', overflowY: 'auto', padding: 12, boxSizing: 'border-box' }}>
                <Detail item={selected} relayerConfigured={relayerConfigured} onClose={() => setSelectedId(null)} onChanged={() => void load()} />
              </div>
            </div>
          )}
        </>
      )}

      {/* Audit log */}
      <AdminCard padding={16}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>
          <Clock size={15} /> Recent admin actions
        </div>
        {log.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', padding: '6px 0' }}>No admin recovery actions yet.</div>
        ) : log.map(l => (
          <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '9px 0', borderTop: '1px solid var(--border)', fontSize: 12.5 }}>
            <span style={{ color: 'var(--text-primary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <b>{l.action.replace(/^admin-/, '').replace(/-/g, ' ')}</b> · {l.target_kind.replace('_', ' ')} {short(l.target_id, 4)}
              {typeof (l.result as any)?.error === 'string' && <span style={{ color: 'var(--danger)' }}> · failed</span>}
            </span>
            <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>{l.admin_email ?? 'admin'} · {ago(l.created_at)}</span>
          </div>
        ))}
      </AdminCard>
    </div>
  )
}
