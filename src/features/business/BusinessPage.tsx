// Business tab (merchants; replaces Rewards in the bottom bar).
//
//   Overview     today's money, Show QR / Charge, ways to get paid, recent
//                payments, business tools
//   Payments     every merchant payment, by day, with where the money is now
//   Settlements  the Ledger (moved here from the Multichain Hub): payments
//                waiting on other chains, Claim All, requests, customers
//
// Reads the same merchant data as before (listMyPayments, live via
// subscribeMerchantPayments); Settlements is the existing Ledger screen, so
// claim logic is unchanged. Business accounts get the whole tab from sign-up;
// until MeshPort approves them, Overview starts with the "complete your
// business account" card.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  QrCode, Calculator, Link2, ReceiptText, Inbox, BarChart3, Volume2, VolumeX, Store, ArrowLeftRight,
  Clock, CheckCircle2, ExternalLink,
} from 'lucide-react'
import { useAuthStore } from '@/store'
import { useMerchant } from '@/lib/merchant'
import { formatAmount } from '@/lib/utils'
import { explorerTxUrl } from '@/lib/chainExplorers'
import { listMyPayments, subscribeMerchantPayments, type MerchantPayment } from '@/lib/merchantPay'
import { useVoiceAlerts, setVoiceAlerts, speakPayment, voiceSupported, VOICE_LANGS } from '@/lib/voiceAlerts'
import { Sheet } from '@/components/ui/Sheet'
import { MultichainPage } from '@/features/multichain/MultichainPage'
import { BusinessSetupCard } from './BusinessSetupCard'

type Tab = 'overview' | 'payments' | 'settlements'

const CHAIN: Record<string, string> = {
  Arc_Testnet: 'Arc', Ethereum_Sepolia: 'Ethereum', Base_Sepolia: 'Base', Arbitrum_Sepolia: 'Arbitrum', Optimism_Sepolia: 'Optimism',
  Polygon_Sepolia: 'Polygon', Avalanche_Fuji: 'Avalanche', HyperEVM_Testnet: 'HyperEVM', Sei_Testnet: 'Sei', Unichain_Sepolia: 'Unichain',
}
const chainName = (c: string) => CHAIN[c] ?? c.replace(/_/g, ' ')

/** Money waiting on another chain (in the merchant's Ledger, not yet on Arc). */
const toSettle = (p: MerchantPayment) => p.method === 'external_ub' && p.status !== 'collected'
const who = (p: MerchantPayment) => p.customerUsername ? `${p.customerUsername}.arc` : `${p.from.slice(0, 6)}…${p.from.slice(-4)}`
const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString()
const dayLabel = (iso: string) => {
  const d = new Date(iso), y = new Date(); y.setDate(y.getDate() - 1)
  if (d.toDateString() === new Date().toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 20, padding: 14 }
const sectionTitle: React.CSSProperties = { fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }

export function BusinessPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { isMerchant, status, application, storeName: accountStoreName } = useMerchant()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const voice = useVoiceAlerts()
  const [tab, setTab] = useState<Tab>(() => {
    const t = (location.state as { btab?: Tab } | null)?.btab ?? new URLSearchParams(location.search).get('tab')
    // Claim tracking links (?claim= / ?chain=) open on Settlements.
    if (new URLSearchParams(location.search).get('claim') || new URLSearchParams(location.search).get('chain')) return 'settlements'
    return t === 'payments' || t === 'settlements' ? t : 'overview'
  })
  const [payments, setPayments] = useState<MerchantPayment[]>([])
  const [loaded, setLoaded] = useState(false)
  const [detail, setDetail] = useState<MerchantPayment | null>(null)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const seen = useRef<Set<string> | null>(null)

  const load = useCallback(async () => {
    const list = await listMyPayments(300)
    // Voice alert for payments that arrived since the last load.
    if (seen.current) for (const p of list) if (!seen.current.has(p.id)) speakPayment(p.amount)
    seen.current = new Set(list.map(p => p.id))
    setPayments(list); setLoaded(true)
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => (walletAddress ? subscribeMerchantPayments(walletAddress, () => { void load() }) : undefined), [walletAddress, load])

  const storeName = application?.businessName || accountStoreName || 'Your business'
  const handle = application?.username ? `${application.username}.arc` : null
  const pendingCount = payments.filter(toSettle).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--bg)' }}>
      {/* Header */}
      <div style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 16px)', background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px 10px' }}>
          <span aria-hidden="true" style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--brand)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 15, flexShrink: 0 }}>
            {storeName.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase()}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{storeName}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
              {isMerchant
                ? <><CheckCircle2 size={13} color="var(--success)" /> Verified merchant{handle ? ` · ${handle}` : ''}</>
                : <><Clock size={13} color="var(--warning)" /> {status === 'pending' ? 'Under review' : 'Not verified yet'}{handle ? ` · ${handle}` : ''}</>}
            </div>
          </div>
          {voiceSupported() && (
            <button onClick={() => setVoiceOpen(true)} aria-label="Voice alerts"
              style={{ width: 40, height: 40, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-primary)' }}>
              {voice.enabled ? <Volume2 size={19} /> : <VolumeX size={19} />}
            </button>
          )}
        </div>
        {(
          <div role="tablist" style={{ display: 'flex', padding: '0 16px' }}>
            {([['overview', 'Overview'], ['payments', 'Payments'], ['settlements', 'Settlements']] as const).map(([id, text]) => (
              <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
                style={{ flex: 1, padding: '10px 0 11px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 13.5, fontWeight: 600,
                  color: tab === id ? 'var(--brand-text)' : 'var(--text-secondary)', borderBottom: `2.5px solid ${tab === id ? 'var(--brand-text)' : 'transparent'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                {text}
                {id === 'settlements' && pendingCount > 0 && (
                  <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9, background: 'color-mix(in srgb, var(--warning) 18%, transparent)', color: 'var(--warning)', fontSize: 11, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{pendingCount}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {tab === 'settlements' ? (
        <MultichainPage mode="ledger" />
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px calc(env(safe-area-inset-bottom, 0px) + 28px)' }}>
          {tab === 'overview'
            ? <Overview payments={payments} loaded={loaded} onTab={setTab} onOpen={p => navigate(p)} onDetail={setDetail} onVoice={() => setVoiceOpen(true)} voiceOn={voice.enabled} />
            : <PaymentsList payments={payments} loaded={loaded} onDetail={setDetail} />}
        </div>
      )}

      <Sheet isOpen={!!detail} onClose={() => setDetail(null)} title="Payment">
        {detail && <PaymentDetail p={detail} onSettle={() => { setDetail(null); setTab('settlements') }} />}
      </Sheet>
      <Sheet isOpen={voiceOpen} onClose={() => setVoiceOpen(false)} title="Voice alerts">
        <VoiceSettings />
      </Sheet>
    </div>
  )
}

// ─── Overview ───────────────────────────────────────────────────────────────
function Overview({ payments, loaded, onTab, onOpen, onDetail, onVoice, voiceOn }: {
  payments: MerchantPayment[]; loaded: boolean; onTab: (t: Tab) => void; onOpen: (path: string) => void
  onDetail: (p: MerchantPayment) => void; onVoice: () => void; voiceOn: boolean
}) {
  const today = useMemo(() => payments.filter(p => isToday(p.createdAt)), [payments])
  const total = today.reduce((s, p) => s + p.amount, 0)
  const customers = new Set(today.map(who)).size
  const waiting = payments.filter(toSettle)
  const waitingTotal = waiting.reduce((s, p) => s + p.amount, 0)
  const waitingChains = new Set(waiting.map(p => p.chain)).size
  const onArcToday = today.filter(p => !toSettle(p)).reduce((s, p) => s + p.amount, 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <BusinessSetupCard />
      {/* Today's collection */}
      <div style={{ background: 'var(--brand)', color: '#fff', borderRadius: 22, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, opacity: 0.9 }}>
          <span>Today's collection</span>
          <button onClick={onVoice} style={{ border: 'none', background: 'rgba(255,255,255,0.15)', color: '#fff', borderRadius: 999, padding: '4px 10px', fontSize: 11.5, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            {voiceOn ? <Volume2 size={13} /> : <VolumeX size={13} />} Voice {voiceOn ? 'on' : 'off'}
          </button>
        </div>
        <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.05, fontVariantNumeric: 'tabular-nums' }}>
          {loaded ? `$${formatAmount(total)}` : '—'}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
          {[['Payments', String(today.length)], ['Average', `$${formatAmount(today.length ? total / today.length : 0)}`], ['Customers', String(customers)]].map(([k, v]) => (
            <div key={k} style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 11, opacity: 0.8 }}>{k}</span>
              <b style={{ fontSize: 15, fontVariantNumeric: 'tabular-nums' }}>{v}</b>
            </div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', background: 'rgba(0,0,0,0.18)', borderRadius: 14, overflow: 'hidden' }}>
          <div style={{ padding: '10px 12px' }}>
            <div style={{ fontSize: 11, opacity: 0.8 }}>On Arc today</div>
            <b style={{ fontSize: 15, fontVariantNumeric: 'tabular-nums' }}>${formatAmount(onArcToday)}</b>
          </div>
          <div style={{ padding: '10px 12px', borderLeft: '1px solid rgba(255,255,255,0.12)' }}>
            <div style={{ fontSize: 11, opacity: 0.8 }}>To settle{waitingChains ? ` · ${waitingChains} chain${waitingChains > 1 ? 's' : ''}` : ''}</div>
            <b style={{ fontSize: 15, fontVariantNumeric: 'tabular-nums' }}>${formatAmount(waitingTotal)}</b>
            {waiting.length > 0 && (
              <button onClick={() => onTab('settlements')} style={{ display: 'block', marginTop: 4, border: 'none', background: '#fff', color: 'var(--brand)', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>
                Settle now
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Get paid in one tap */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 10 }}>
        <button onClick={() => onOpen('/receive')} style={bigBtn(true)}><QrCode size={20} /> Show QR</button>
        <button onClick={() => onOpen('/receive?tab=merchant')} style={bigBtn(false)}><Calculator size={20} /> Charge</button>
      </div>

      <div style={card}>
        <h3 style={{ ...sectionTitle, marginBottom: 10 }}>Get paid</h3>
        <div style={grid4}>
          <GridItem icon={<Link2 size={22} />} label="Payment link" onClick={() => onOpen('/receive?tab=merchant')} />
          <GridItem icon={<ReceiptText size={22} />} label="Send bill" onClick={() => onOpen('/chat')} />
          <GridItem icon={<Inbox size={22} />} label="Requests" onClick={() => onOpen('/receive/requests')} />
          <GridItem icon={<ArrowLeftRight size={22} />} label="Settle" onClick={() => onTab('settlements')} />
        </div>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h3 style={sectionTitle}>Recent payments</h3>
          <button onClick={() => onTab('payments')} style={linkBtn}>See all</button>
        </div>
        {!loaded ? <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '8px 0' }}>Loading…</div>
          : payments.length === 0 ? <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '8px 0' }}>No payments yet. Tap Show QR and let your first customer scan it.</div>
          : payments.slice(0, 4).map(p => <PaymentRow key={p.id} p={p} onClick={() => onDetail(p)} />)}
      </div>

      <div style={card}>
        <h3 style={{ ...sectionTitle, marginBottom: 10 }}>Manage business</h3>
        <div style={grid4}>
          <GridItem icon={<BarChart3 size={22} />} label="Insights" onClick={() => onOpen('/insights')} />
          <GridItem icon={<Volume2 size={22} />} label="Voice alerts" onClick={onVoice} />
          <GridItem icon={<ArrowLeftRight size={22} />} label="Cross-chain" onClick={() => onOpen('/multichain')} />
          <GridItem icon={<Store size={22} />} label="Profile" onClick={() => onOpen('/merchant')} />
        </div>
      </div>
    </div>
  )
}

// ─── Payments ───────────────────────────────────────────────────────────────
function PaymentsList({ payments, loaded, onDetail }: { payments: MerchantPayment[]; loaded: boolean; onDetail: (p: MerchantPayment) => void }) {
  const [filter, setFilter] = useState<'all' | 'arc' | 'settle'>('all')
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const list = payments.filter(p =>
    (filter === 'all' || (filter === 'settle' ? toSettle(p) : !toSettle(p))) &&
    (!needle || who(p).toLowerCase().includes(needle) || (p.orderNumber ?? '').toLowerCase().includes(needle)))
  const days: string[] = []
  for (const p of list) { const d = dayLabel(p.createdAt); if (!days.includes(d)) days.push(d) }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name or order number" aria-label="Search payments"
        style={{ width: '100%', boxSizing: 'border-box', minHeight: 44, borderRadius: 14, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)', padding: '0 14px', fontSize: 14 }} />
      <div style={{ display: 'flex', gap: 6 }}>
        {([['all', 'All'], ['arc', 'Received on Arc'], ['settle', 'To settle']] as const).map(([id, text]) => (
          <button key={id} onClick={() => setFilter(id)}
            style={{ border: '1px solid var(--border)', borderRadius: 999, padding: '7px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
              background: filter === id ? 'var(--text-primary)' : 'var(--surface)', color: filter === id ? 'var(--bg)' : 'var(--text-primary)' }}>
            {text}
          </button>
        ))}
      </div>
      {!loaded ? <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Loading…</div>
        : days.length === 0 ? <div style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center', padding: 24 }}>No payments match.</div>
        : days.map(d => {
          const items = list.filter(p => dayLabel(p.createdAt) === d)
          return (
            <div key={d}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '6px 2px' }}>
                {d} · ${formatAmount(items.reduce((s, p) => s + p.amount, 0))}
              </div>
              <div style={{ ...card, padding: '2px 14px' }}>
                {items.map(p => <PaymentRow key={p.id} p={p} onClick={() => onDetail(p)} />)}
              </div>
            </div>
          )
        })}
    </div>
  )
}

function PaymentRow({ p, onClick }: { p: MerchantPayment; onClick: () => void }) {
  const settle = toSettle(p)
  return (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '10px 0', border: 'none', borderBottom: '1px solid var(--border)', background: 'none', textAlign: 'left', cursor: 'pointer', color: 'var(--text-primary)' }}>
      <span aria-hidden="true" style={{ width: 38, height: 38, borderRadius: '50%', background: 'color-mix(in srgb, var(--brand) 14%, transparent)', color: 'var(--brand-text)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, flexShrink: 0 }}>
        {p.customerUsername ? p.customerUsername.slice(0, 2).toUpperCase() : '0x'}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <b style={{ display: 'block', fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{who(p)}</b>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{timeOf(p.createdAt)} · {chainName(p.chain)}{p.orderNumber ? ` · ${p.orderNumber}` : ''}</span>
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
        <b style={{ fontSize: 14.5, fontVariantNumeric: 'tabular-nums' }}>+${formatAmount(p.amount)}</b>
        <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 999,
          background: `color-mix(in srgb, var(${settle ? '--warning' : '--success'}) 15%, transparent)`, color: `var(${settle ? '--warning' : '--success'})` }}>
          {settle ? 'To settle' : 'Received'}
        </span>
      </span>
    </button>
  )
}

function PaymentDetail({ p, onSettle }: { p: MerchantPayment; onSettle: () => void }) {
  const onArc = p.chain === 'Arc_Testnet'
  const steps: { title: string; sub: string; state: 'done' | 'now' | 'next' }[] = onArc
    ? [{ title: 'Paid on Arc', sub: new Date(p.createdAt).toLocaleString(), state: 'done' }, { title: 'In your Arc balance', sub: 'Ready to use', state: 'done' }]
    : [
        { title: `Paid on ${chainName(p.chain)}`, sub: new Date(p.createdAt).toLocaleString(), state: 'done' },
        { title: 'Waiting to settle', sub: `In your ${chainName(p.chain)} Ledger`, state: toSettle(p) ? 'now' : 'done' },
        { title: 'In your Arc balance', sub: toSettle(p) ? 'Tap Settle now in Settlements' : 'Settled', state: toSettle(p) ? 'next' : 'done' },
      ]
  const url = explorerTxUrl(p.chain, p.txHash)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>From {who(p)}</div>
        <div style={{ fontSize: 34, fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>${formatAmount(p.amount)}</div>
      </div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {steps.map(s => (
          <li key={s.title} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span aria-hidden="true" style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: s.state === 'done' ? 'var(--success)' : s.state === 'now' ? 'var(--warning)' : 'var(--border)', color: '#fff' }}>
              {s.state === 'done' ? <CheckCircle2 size={14} /> : s.state === 'now' ? <Clock size={13} /> : null}
            </span>
            <span><b style={{ fontSize: 13.5, color: 'var(--text-primary)' }}>{s.title}</b><br /><span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{s.sub}</span></span>
          </li>
        ))}
      </ol>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {p.orderNumber && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Order</span><b style={{ color: 'var(--text-primary)' }}>{p.orderNumber}</b></div>}
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Network</span><b style={{ color: 'var(--text-primary)' }}>{chainName(p.chain)}</b></div>
        {url && <a href={url} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--brand-text)', fontWeight: 600 }}>View transaction <ExternalLink size={14} /></a>}
      </div>
      {toSettle(p) && <button onClick={onSettle} style={bigBtn(true)}>Settle now</button>}
    </div>
  )
}

// ─── Voice alerts ───────────────────────────────────────────────────────────
function VoiceSettings() {
  const v = useVoiceAlerts()
  if (!voiceSupported()) return <p style={{ fontSize: 14, color: 'var(--text-secondary)' }}>This device can't speak alerts.</p>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, cursor: 'pointer' }}>
        <span><b style={{ fontSize: 14, color: 'var(--text-primary)' }}>Speak each payment</b><br /><span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>While MeshPort is open on this device</span></span>
        <input type="checkbox" checked={v.enabled} onChange={e => setVoiceAlerts({ enabled: e.target.checked })} style={{ width: 22, height: 22, accentColor: 'var(--brand)' }} />
      </label>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>Language</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {VOICE_LANGS.map(l => (
            <button key={l.id} onClick={() => setVoiceAlerts({ lang: l.id })}
              style={{ border: `1px solid ${v.lang === l.id ? 'var(--brand)' : 'var(--border)'}`, borderRadius: 999, padding: '7px 13px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                background: v.lang === l.id ? 'color-mix(in srgb, var(--brand) 14%, transparent)' : 'var(--surface)', color: v.lang === l.id ? 'var(--brand-text)' : 'var(--text-primary)' }}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
      <button onClick={() => speakPayment(24, { test: true })} style={bigBtn(true)}><Volume2 size={18} /> Play a test alert</button>
    </div>
  )
}

// ─── Bits ───────────────────────────────────────────────────────────────────
const grid4: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6 }
const linkBtn: React.CSSProperties = { border: 'none', background: 'none', color: 'var(--brand-text)', fontWeight: 700, fontSize: 13, cursor: 'pointer', padding: '4px 0' }
function bigBtn(primary: boolean): React.CSSProperties {
  return {
    minHeight: 52, borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 14px',
    fontSize: 15, fontWeight: 700, cursor: 'pointer', width: '100%',
    border: primary ? 'none' : '1px solid var(--border)', background: primary ? 'var(--brand)' : 'var(--surface)', color: primary ? '#fff' : 'var(--text-primary)',
  }
}
function GridItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ border: 'none', background: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '6px 0', cursor: 'pointer', fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)', textAlign: 'center', lineHeight: 1.2 }}>
      <span style={{ width: 48, height: 48, borderRadius: 16, background: 'color-mix(in srgb, var(--brand) 12%, transparent)', color: 'var(--brand-text)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</span>
      {label}
    </button>
  )
}
