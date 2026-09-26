// Merchant Ledger (Multichain Hub → Ledger, approved merchants only).
//   • Receive payment → payment request with QR + link (share / send in chat)
//   • Arriving payments (paid on another chain, being moved to Arc)
//   • Customers: totals, count, last payment → per-customer history
//   • Requests: every request and its live status
// All numbers come from merchant_payment_intents / merchant_payments, which
// only the merchant-pay Edge Function changes after verifying on-chain.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Copy, Share2, MessageCircle, QrCode, Search, Users, Clock, CheckCircle2, XCircle } from 'lucide-react'
import { useAuthStore, useUIStore } from '@/store'
import { formatAmount, timeAgo, copyToClipboard } from '@/lib/utils'
import {
  createPaymentRequest, listMyIntents, listMyPayments, subscribeMerchantPayments, paymentLink, orderPayLink, orderChainPayLink,
  cancelPayment, submitPayment, STATUS_LABEL, paymentStageLabel, isArriving, orderLabel, paymentRequestMessage,
  listUnmatchedDeposits, assignDeposit, dismissDeposit, completeOrder,
  listChainReceipts, getAutoConvert, setAutoConvert,
  type MerchantIntent, type MerchantPayment, type UnmatchedDeposit, type ChainReceipt, type AutoConvert,
} from '@/lib/merchantPay'
import { merchantQrChain, MERCHANT_QR_EXTERNAL } from '@/lib/merchantQr'
import { ChainPicker, WalletPaymentDetails } from './MerchantQrPanel'

/** Chat text for a request / bill — the chat renders it as a live card. */
function chatMessageFor(i: MerchantIntent): string {
  if (i.kind === 'invoice') {
    const lines = (i.items ?? []).map(x => `${x.name} × ${x.qty}`).join(', ')
    return `🧾 Bill · Order #${orderLabel(i)} · $${formatAmount(i.amount)} USDC${lines ? `\n${lines}` : ''}${i.note ? `\n${i.note}` : ''}\n${paymentLink(i.code)}`
  }
  return paymentRequestMessage(i, formatAmount(i.amount))
}

const CHAIN_LABEL: Record<string, string> = {
  Arc_Testnet: 'Arc', Ethereum_Sepolia: 'Ethereum', Base_Sepolia: 'Base', Arbitrum_Sepolia: 'Arbitrum', Optimism_Sepolia: 'Optimism',
  Polygon_Sepolia: 'Polygon', Avalanche_Fuji: 'Avalanche', HyperEVM_Testnet: 'HyperEVM', Sei_Testnet: 'Sei', Unichain_Sepolia: 'Unichain',
}
const routeLabel = (chain?: string | null) => !chain ? '' : chain === 'Arc_Testnet' ? 'Arc' : `${CHAIN_LABEL[chain] ?? chain.replace(/_/g, ' ')} → Arc`
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`


type View = { kind: 'home' } | { kind: 'request'; code: string } | { kind: 'customer'; key: string }

const card: React.CSSProperties = { background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', border: '1px solid var(--border)', borderRadius: 16 }
const btnPrimary: React.CSSProperties = { padding: '13px 16px', borderRadius: 14, border: '1px solid color-mix(in srgb, black 12%, transparent)', background: 'var(--brand)', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }
const btnGhost: React.CSSProperties = { padding: '11px 14px', borderRadius: 14, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '12px 14px', borderRadius: 14, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 14, outline: 'none' }

export function MerchantLedger({ children, boxStyle, ledgerBalance, ledgerChains }: {
  children?: React.ReactNode; boxStyle?: React.CSSProperties
  /** Real USDC on the Ledger chains (what the Hub card shows); undefined while scanning. */
  ledgerBalance?: number; ledgerChains?: number
}) {
  const walletAddress = useAuthStore(s => s.walletAddress)
  const [view, setView] = useState<View>({ kind: 'home' })
  const [intents, setIntents] = useState<MerchantIntent[]>([])
  const [payments, setPayments] = useState<MerchantPayment[]>([])
  const [loaded, setLoaded] = useState(false)
  const [review, setReview] = useState<UnmatchedDeposit[]>([])
  const [receipts, setReceipts] = useState<ChainReceipt[]>([])
  const [auto, setAuto] = useState<AutoConvert | null>(null)

  const load = useCallback(async () => {
    const [i, p, r] = await Promise.all([listMyIntents(), listMyPayments(), listUnmatchedDeposits().catch(() => [])])
    setIntents(i); setPayments(p); setReview(r); setLoaded(true)
    listChainReceipts().then(setReceipts).catch(() => {})
    getAutoConvert().then(setAuto).catch(() => {})
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => walletAddress ? subscribeMerchantPayments(walletAddress, () => { void load() }) : undefined, [walletAddress, load])
  // Direct deposits are matched by the server every minute — refresh too.
  useEffect(() => { const t = setInterval(() => { void load() }, 60_000); return () => clearInterval(t) }, [load])

  const navigate = useNavigate()
  const box = (el: React.ReactNode) => <div style={boxStyle}>{el}</div>
  // New payment requests / QR live in Home → Receive.
  const newRequest = (customer?: string) => navigate(`/receive?request=1${customer ? `&customer=${encodeURIComponent(customer)}` : ''}`)
  if (view.kind === 'request') {
    const it = intents.find(i => i.code === view.code)
    return box(<RequestDetail code={view.code} intent={it ?? null} payments={payments.filter(p => p.intentId === it?.id)} onBack={() => setView({ kind: 'home' })} onChanged={load} />)
  }
  if (view.kind === 'customer') {
    return box(<CustomerDetail keyId={view.key} payments={payments} intents={intents}
      onBack={() => setView({ kind: 'home' })} onRequest={c => newRequest(c)} onOpenRequest={code => setView({ kind: 'request', code })} />)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {review.length > 0 && box(<NeedsReview deposits={review} intents={intents} onDone={load} />)}
      {box(<LedgerHome loaded={loaded} intents={intents} payments={payments} receipts={receipts} auto={auto} onAutoChange={setAuto} chains={children}
        ledgerBalance={ledgerBalance} ledgerChains={ledgerChains}
        onOpenRequest={code => setView({ kind: 'request', code })} onOpenCustomer={key => setView({ kind: 'customer', key })} />)}
    </div>
  )
}

// ── Home ───────────────────────────────────────────────────────────────────
type Customer = { key: string; name: string; total: number; count: number; last: string; search: string }

function customersOf(payments: MerchantPayment[]): Customer[] {
  const map = new Map<string, Customer>()
  for (const p of payments) {
    const key = p.customerUsername ? `u:${p.customerUsername}` : `w:${p.from}`
    const name = p.customerUsername ? `${p.customerUsername}.arc` : short(p.from)
    const c = map.get(key) ?? { key, name, total: 0, count: 0, last: p.createdAt, search: name.toLowerCase() }
    c.total += p.amount; c.count += 1
    // Searchable by username and by every wallet address they paid from.
    const from = (p.from ?? '').toLowerCase()
    if (from && !c.search.includes(from)) c.search += ' ' + from
    if (p.createdAt > c.last) c.last = p.createdAt
    map.set(key, c)
  }
  return [...map.values()].sort((a, b) => b.last.localeCompare(a.last))
}

function LedgerHome({ loaded, intents, payments, receipts, auto, onAutoChange, chains, onOpenRequest, onOpenCustomer, ledgerBalance, ledgerChains }: {
  loaded: boolean; intents: MerchantIntent[]; payments: MerchantPayment[]; chains?: React.ReactNode
  ledgerBalance?: number; ledgerChains?: number
  receipts: ChainReceipt[]; auto: AutoConvert | null; onAutoChange: (a: AutoConvert) => void
  onOpenRequest: (code: string) => void; onOpenCustomer: (key: string) => void
}) {
  const [tab, setTab] = useState<'requests' | 'customers' | 'chains'>('requests')
  const [q, setQ] = useState('')
  const [showAllReq, setShowAllReq] = useState(false)
  const [showAllCust, setShowAllCust] = useState(false)
  const arriving = payments.filter(isArriving)
  // The real USDC on the Ledger chains (same as the Hub card). Payment records
  // only cover what arrived since tracking began, so they're just a fallback
  // while the chain balances load.
  const waitingTotal = ledgerBalance ?? receipts.filter(r => r.status !== 'converted').reduce((sum, r) => sum + r.amount, 0)
  const onTheWay = arriving.reduce((s, p) => s + p.amount, 0)
  const allCustomers = useMemo(() => customersOf(payments), [payments])
  const needle = q.trim().toLowerCase().replace(/^@/, '')
  const customers = allCustomers.filter(c => !needle || c.search.includes(needle))
  const openRequests = intents.filter(i => ['pending', 'partially_paid', 'processing'].includes(i.status))
  const history = intents.filter(i => !['pending', 'partially_paid', 'processing'].includes(i.status))
  const received = payments.reduce((s, p) => s + p.amount, 0)
  const intentByPay = new Map(intents.map(i => [i.id, i]))
  const LIMIT = 6

  const stat = (title: string, value: string, sub?: string, color?: string) => (
    <div style={{ flex: 1, minWidth: 0, padding: '10px 12px' }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{title}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: color ?? 'var(--text-primary)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>}
    </div>
  )
  const divider = <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)', margin: '8px 0' }} />
  const requestRow = (i: MerchantIntent) => (
    <Row key={i.id}
      icon={i.status === 'paid' ? <CheckCircle2 size={16} color="var(--success)" /> : ['expired', 'cancelled', 'failed'].includes(i.status) ? <XCircle size={16} color="var(--text-secondary)" /> : <Clock size={16} color="var(--warning)" />}
      title={`${i.kind === 'invoice' ? 'Bill · ' : ''}$${formatAmount(i.amount)} USDC${i.note ? ' · ' + i.note : ''}`}
      sub={`#${orderLabel(i)} · ${i.customerUsername ? i.customerUsername + '.arc · ' : ''}${i.status === 'paid' && i.completedByMerchant ? 'Completed by you' : STATUS_LABEL[i.status]}${i.sourceChain ? ' · ' + routeLabel(i.sourceChain) : ''} · ${timeAgo(i.createdAt)}`}
      onClick={() => onOpenRequest(i.code)} amountColor={i.status === 'paid' ? 'var(--success)' : undefined} />
  )
  const more = (shown: number, total: number, open: boolean, toggle: () => void) => total > shown || open ? (
    <button onClick={toggle} style={{ ...btnGhost, border: 'none', padding: '6px', color: 'var(--brand)', fontSize: 12.5 }}>
      {open ? 'Show less' : `Show all (${total})`}
    </button>
  ) : null

  const reqList = showAllReq ? history : history.slice(0, LIMIT)
  const custList = showAllCust ? customers : customers.slice(0, LIMIT)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Summary — one compact row */}
      <div style={{ ...card, display: 'flex', alignItems: 'stretch' }}>
        {stat('Received', `$${formatAmount(received)}`, `${payments.length} payment${payments.length === 1 ? '' : 's'}`)}
        {divider}
        {stat('Open', String(openRequests.length), 'requests', openRequests.length ? 'var(--warning)' : undefined)}
        {divider}
        {stat('Customers', String(allCustomers.length))}
      </div>

      {waitingTotal > 0 && (
        <button onClick={() => setTab('chains')} style={{ ...card, padding: '10px 12px', textAlign: 'left', cursor: 'pointer', borderColor: 'color-mix(in srgb, var(--warning) 35%, var(--border))' }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--warning)' }}>${formatAmount(waitingTotal)} USDC on {ledgerChains ? `${ledgerChains} other chain${ledgerChains === 1 ? '' : 's'}` : 'other chains'}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
            {auto?.enabled ? `Auto-convert moves it to Arc${auto.nextRunAt ? ` · next run ${fmtWhen(auto.nextRunAt)}` : ''}` : 'Auto-convert is off — turn it on in Chains to move it to Arc'}
          </div>
        </button>
      )}

      {waitingTotal === 0 && arriving.length > 0 && (
        <div style={{ ...card, padding: 10, display: 'flex', flexDirection: 'column', gap: 6, borderColor: 'color-mix(in srgb, var(--warning) 35%, var(--border))' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--warning)' }}>Arriving · ${formatAmount(onTheWay)} USDC moving to Arc</div>
          {arriving.slice(0, 3).map(p => (
            <button key={p.id} onClick={() => { const i = intentByPay.get(p.intentId); if (i) onOpenRequest(i.code) }}
              style={{ display: 'flex', justifyContent: 'space-between', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', fontSize: 12.5, color: 'var(--text-primary)' }}>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.customerUsername ? p.customerUsername + '.arc' : short(p.from)} · {routeLabel(p.chain)} · {paymentStageLabel(p)}
              </span>
              <b style={{ flexShrink: 0 }}>${formatAmount(p.amount)}</b>
            </button>
          ))}
          {arriving.length > 3 && <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>+{arriving.length - 3} more</div>}
        </div>
      )}

      {/* Sub-tabs keep the page short */}
      <div role="tablist" style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 12, border: '1px solid var(--border)' }}>
        {([['chains', 'Chains'], ['requests', `Requests${openRequests.length ? ` (${openRequests.length})` : ''}`], ['customers', 'Customers']] as const).map(([id, text]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            style={{ flex: 1, padding: '8px 4px', borderRadius: 9, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
              background: tab === id ? 'color-mix(in srgb, var(--brand) 16%, transparent)' : 'transparent', color: tab === id ? 'var(--brand)' : 'var(--text-secondary)' }}>
            {text}
          </button>
        ))}
      </div>

      {tab === 'requests' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!loaded ? <Empty text="Loading…" /> : intents.length === 0 ? (
            <Empty text="No payment requests yet. Create one from Home → Receive." />
          ) : (
            <>
              {openRequests.length > 0 && <Section title="Open">{openRequests.map(requestRow)}</Section>}
              {history.length > 0 && (
                <Section title="History">
                  {reqList.map(requestRow)}
                  {more(LIMIT, history.length, showAllReq, () => setShowAllReq(v => !v))}
                </Section>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'customers' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ position: 'relative' }}>
            <Search size={15} color="var(--text-secondary)" style={{ position: 'absolute', left: 12, top: 13 }} />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search username or address" autoCapitalize="none" autoCorrect="off" spellCheck={false} style={{ ...input, paddingLeft: 34 }} />
          </div>
          {!loaded ? <Empty text="Loading…" /> : customers.length === 0 ? <Empty text={needle ? 'No customer matches this username or address.' : 'Customers who pay you will show here.'} /> : (
            <>
              {custList.map(c => (
                <Row key={c.key} icon={<Users size={16} color="var(--brand)" />} title={c.name}
                  sub={`$${formatAmount(c.total)} received · ${c.count} transaction${c.count === 1 ? '' : 's'} · last ${timeAgo(c.last)}`} onClick={() => onOpenCustomer(c.key)} />
              ))}
              {more(LIMIT, customers.length, showAllCust, () => setShowAllCust(v => !v))}
            </>
          )}
        </div>
      )}

      {tab === 'chains' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <AutoConvertCard auto={auto} onChange={onAutoChange} />
          <div style={{ margin: '0 -2px' }}>{chains}</div>
        </div>
      )}
    </div>
  )
}

const fmtWhen = (iso: string) => {
  const d = new Date(iso)
  const today = d.toDateString() === new Date().toDateString()
  return `${today ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', '}${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

/** Auto-convert: other-chain funds → Ledger → Arc, every 6 hours (off by default). */
function AutoConvertCard({ auto, onChange }: { auto: AutoConvert | null; onChange: (a: AutoConvert) => void }) {
  const { showToastMessage } = useUIStore()
  const [busy, setBusy] = useState(false)
  const on = !!auto?.enabled
  const toggle = async () => {
    setBusy(true)
    try {
      const next = await setAutoConvert(!on)
      onChange(next)
      showToastMessage(next.enabled ? 'Auto-convert is on' : 'Auto-convert is off', 'success')
    } catch (e) {
      showToastMessage(e instanceof Error ? e.message : 'Could not change auto-convert', 'error')
    }
    setBusy(false)
  }
  const next = on && auto?.nextRunAt ? new Date(auto.nextRunAt) : null
  const toArc = next ? new Date(next.getTime() + 60 * 60_000) : null
  return (
    <div style={{ ...card, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Auto-convert to Arc</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.4 }}>
            Every 6 hours: all chains into your Ledger, then one transfer to your Arc balance an hour later. Minimum $2.
          </div>
        </div>
        <button onClick={toggle} disabled={busy || !auto && busy} role="switch" aria-checked={on} aria-label="Auto-convert"
          style={{ flexShrink: 0, width: 46, height: 26, borderRadius: 999, border: 'none', cursor: 'pointer', position: 'relative', opacity: busy ? 0.6 : 1,
            background: on ? 'var(--brand)' : 'color-mix(in srgb, var(--text-primary) 18%, transparent)', transition: 'background 0.15s' }}>
          <span style={{ position: 'absolute', top: 3, left: on ? 23 : 3, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'left 0.15s' }} />
        </button>
      </div>
      {on && next && toArc && (
        <div style={{ fontSize: 12, color: 'var(--text-primary)', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span>Next: into Ledger <b>{fmtWhen(next.toISOString())}</b> · to Arc <b>{fmtWhen(toArc.toISOString())}</b></span>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Runs when MeshPort is open at or after that time (it needs your wallet to sign).</span>
        </div>
      )}
      {!on && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Off — payments on other chains stay there until you turn this on or collect them yourself.</div>}
      {auto?.lastResult && <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Last run{auto.lastRunAt ? ` (${fmtWhen(auto.lastRunAt)})` : ''}: {auto.lastResult}</div>}
    </div>
  )
}

// ── Request detail (QR / link / status) ─────────────────────────────────────
function RequestDetail({ code, intent, payments, onBack, onChanged }: {
  code: string; intent: MerchantIntent | null; payments: MerchantPayment[]; onBack: () => void; onChanged: () => void
}) {
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const { showToastMessage } = useUIStore()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const link = orderPayLink(code, intent?.orderNumber)
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [vChain, setVChain] = useState('Arc_Testnet')
  const [vHash, setVHash] = useState('')
  const [busy, setBusy] = useState(false)

  const walletAddress = useAuthStore(s => s.walletAddress)
  // MeshPort QR: Arc — EIP-681 (address + amount due + Arc) for any wallet,
  // plus the order's pay link for MeshPort's scanner (order, amount fixed).
  // Merchant QR: one of the other networks — ONLY address + amount + network.
  // A wallet payment is linked to this order by the deposit watcher.
  const [qrMode, setQrMode] = useState<'link' | 'wallet'>('link')
  const [qrChain, setQrChain] = useState(MERCHANT_QR_EXTERNAL[0].id)
  const dueNow = intent ? Math.max(0, Math.round((intent.amount - intent.received) * 1e6) / 1e6) : 0
  const shownChain = qrMode === 'wallet' ? qrChain : 'Arc_Testnet'
  const qrValue = !walletAddress || !(dueNow > 0) ? link
    : qrMode === 'wallet' ? orderChainPayLink(code, intent?.orderNumber, qrChain)
    : link

  useEffect(() => {
    if (!canvasRef.current) return
    import('qrcode').then(Q => Q.toCanvas(canvasRef.current!, qrValue, { width: 220, margin: 2, color: { dark: '#000000', light: '#ffffff' }, errorCorrectionLevel: 'M' })).catch(() => {})
  }, [qrValue])

  const message = !intent ? link
    : qrMode === 'wallet' && walletAddress
    ? `Pay $${formatAmount(dueNow)} USDC on ${merchantQrChain(qrChain).label} · Order #${orderLabel(intent)}\n${qrValue}`
    : `Payment request · Order #${orderLabel(intent)}: $${formatAmount(intent.amount)} USDC${intent.note ? ` · ${intent.note}` : ''}\n${link}`

  const copy = (text: string, what: string) =>
    copyToClipboard(text).then(ok => showToastMessage(ok ? `${what} copied` : 'Could not copy', ok ? 'success' : 'error'))

  // Shareable image: QR + amount + order number + link, so the QR always
  // travels with the link.
  const qrImage = async (): Promise<File | null> => {
    const qr = canvasRef.current
    if (!qr || !intent) return null
    const W = 600, H = 780
    const c = document.createElement('canvas'); c.width = W; c.height = H
    const g = c.getContext('2d'); if (!g) return null
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H)
    g.fillStyle = '#111111'; g.textAlign = 'center'
    g.font = '700 26px system-ui, sans-serif'; g.fillText('Payment request', W / 2, 60)
    g.font = '800 46px system-ui, sans-serif'; g.fillText(`$${formatAmount(intent.amount)} USDC`, W / 2, 122)
    g.font = '600 24px system-ui, sans-serif'; g.fillStyle = '#444444'; g.fillText(`Order #${orderLabel(intent)}`, W / 2, 162)
    g.drawImage(qr, (W - 420) / 2, 190, 420, 420)
    g.font = '500 18px system-ui, sans-serif'; g.fillStyle = '#555555'
    g.fillText(qrMode === 'wallet' ? `Scan with any wallet · ${merchantQrChain(qrChain).label} · amount fills in` : 'Scan with MeshPort or any wallet · Arc network', W / 2, 650)
    g.font = '500 17px ui-monospace, monospace'; g.fillStyle = '#111111'
    g.fillText(qrMode === 'wallet' ? (walletAddress ?? '') : (link.length > 52 ? link.slice(0, 52) + '…' : link), W / 2, 690)

    const blob: Blob | null = await new Promise(r => c.toBlob(b => r(b), 'image/png'))
    return blob ? new File([blob], `payment-${orderLabel(intent)}-${merchantQrChain(shownChain).label.toLowerCase()}.png`, { type: 'image/png' }) : null
  }

  const share = async () => {
    const file = await qrImage().catch(() => null)
    if (typeof navigator.share === 'function') {
      try {
        const withFile = file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })
        await navigator.share(withFile
          ? { title: 'Payment request', text: message, files: [file!] }
          : { title: 'Payment request', text: message, url: qrMode === 'wallet' ? qrValue : link })
        return
      } catch (e: any) { if (e?.name === 'AbortError') return }
    }
    // No share sheet (desktop): save the QR image and copy the link.
    if (file) saveQr(file)
    const ok = await copyToClipboard(message)
    showToastMessage(ok ? 'QR saved and link copied' : 'Could not copy', ok ? 'success' : 'error')
  }

  const saveQr = (file: File) => {
    const url = URL.createObjectURL(file)
    const a = document.createElement('a'); a.href = url; a.download = file.name
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const downloadQr = async () => {
    const file = await qrImage().catch(() => null)
    if (file) saveQr(file); else showToastMessage('Could not create the QR image', 'error')
  }

  const sendInChat = async () => {
    if (!intent?.customerUsername || !user?.id) return
    try {
      const [{ getUserByUsername }, { ensureConversation }] = await Promise.all([import('@/lib/supabase'), import('@/lib/chatService')])
      const other = await getUserByUsername(intent.customerUsername)
      if (!other?.id) { showToastMessage(`${intent.customerUsername}.arc isn't on MeshPort`, 'error'); return }
      const convId = await ensureConversation(user.id, other.id)
      if (!convId) throw new Error('Could not open the chat')
      navigate(`/chat/${convId}`, { state: { autoSend: chatMessageFor(intent) } })
    } catch (e) {
      showToastMessage(e instanceof Error ? e.message : 'Could not open the chat', 'error')
    }
  }

  const cancel = async () => {
    setBusy(true)
    try { await cancelPayment(code); onChanged() } catch (e) { showToastMessage(e instanceof Error ? e.message : 'Could not cancel', 'error') }
    setBusy(false)
  }

  const verify = async () => {
    setBusy(true)
    try {
      const v = await submitPayment(code, vChain, vHash.trim(), { merchantVerify: true })
      showToastMessage(v.pending ? 'Not confirmed on-chain yet — try again shortly' : 'Payment checked', v.pending ? 'info' : 'success')
      setVerifyOpen(false); setVHash(''); onChanged()
    } catch (e) {
      showToastMessage(e instanceof Error ? e.message : 'Could not verify', 'error')
    }
    setBusy(false)
  }

  const st = intent?.status ?? 'pending'
  const done = ['paid', 'expired', 'cancelled', 'failed'].includes(st)
  // Mark as completed: any order not already paid / cancelled (also expired).
  const canComplete = !!intent && !['paid', 'cancelled'].includes(st)
  const [completeOpen, setCompleteOpen] = useState(false)
  const [completeNote, setCompleteNote] = useState('')
  const complete = async () => {
    setBusy(true)
    try {
      await completeOrder(code, completeNote.trim() || undefined)
      showToastMessage(`Order #${intent ? orderLabel(intent) : ''} marked as completed`, 'success')
      setCompleteOpen(false); setCompleteNote(''); onChanged()
    } catch (e) {
      showToastMessage(e instanceof Error ? e.message : 'Could not complete the order', 'error')
    }
    setBusy(false)
  }
  const over = intent ? Math.round((intent.received - intent.amount) * 1e6) / 1e6 : 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Header title="Payment request" onBack={onBack} />
      {intent && (
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--text-primary)' }}>${formatAmount(intent.amount)} <span style={{ fontSize: 15, color: 'var(--text-secondary)' }}>USDC</span></div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginTop: 2 }}>Order #{orderLabel(intent)}</div>
          {intent.customerUsername && <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>Customer · {intent.customerUsername}.arc</div>}
          {intent.note && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{intent.note}</div>}
          {intent.items?.length ? (
            <div style={{ ...card, padding: 12, marginTop: 10, textAlign: 'left' }}>
              {intent.items.map((i, k) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, padding: '3px 0', color: 'var(--text-primary)' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.name} <span style={{ color: 'var(--text-secondary)' }}>× {i.qty} @ ${formatAmount(i.price)}</span></span>
                  <span style={{ fontWeight: 600 }}>${formatAmount(i.total ?? i.qty * i.price)}</span>
                </div>
              ))}
            </div>
          ) : null}
          <div style={{ fontSize: 13, fontWeight: 700, marginTop: 6, color: st === 'paid' ? 'var(--success)' : done ? 'var(--text-secondary)' : 'var(--warning)' }}>
            {st === 'paid' && intent.completedByMerchant ? 'Completed by you' : STATUS_LABEL[st]}
            {intent.received > 0 && st !== 'paid' ? ` · $${formatAmount(intent.received)} of $${formatAmount(intent.amount)} received` : ''}
            {intent.completedByMerchant && intent.received > 0 && intent.received < intent.amount ? ` · $${formatAmount(intent.received)} received` : ''}
          </div>
          {over > 0.000001 && (
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--warning)', marginTop: 2 }}>Overpaid by ${formatAmount(over)} USDC — you may want to refund it</div>
          )}
          {intent.completedNote && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>Note: {intent.completedNote}</div>}
        </div>
      )}

      {!done && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 12, border: '1px solid var(--border)' }}>
              {([['link', 'MeshPort QR'], ['wallet', 'Merchant QR']] as const).map(([m, label]) => (
                <button key={m} onClick={() => setQrMode(m)} disabled={m === 'wallet' && !walletAddress}
                  style={{ padding: '7px 14px', borderRadius: 9, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
                    background: qrMode === m ? 'var(--brand)' : 'transparent', color: qrMode === m ? '#fff' : 'var(--text-secondary)' }}>
                  {label}
                </button>
              ))}
            </div>
            {qrMode === 'wallet' && <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}><ChainPicker value={qrChain} onChange={setQrChain} /></div>}
            <div style={{ background: '#fff', padding: 8, borderRadius: 16 }}><canvas ref={canvasRef} /></div>
            {qrMode === 'wallet' && walletAddress && dueNow > 0
              ? <WalletPaymentDetails chainId={qrChain} to={walletAddress} amount={dueNow} />
              : <div style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center', maxWidth: 320, lineHeight: 1.45 }}>
                  Scan with MeshPort or any wallet app (MetaMask, OKX, Trust, Coinbase…) — the amount and order are fixed; wallets get Arc, the address and the amount filled in.
                </div>}
          </div>
          <div style={{ ...card, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {qrMode === 'link' && <CopyRow label="Payment link" value={link} onCopy={() => copy(link, 'Link')} />}
            {walletAddress && (
              <CopyRow label="Wallet address (Arc & supported chains)" value={walletAddress} mono onCopy={() => copy(walletAddress, 'Address')} />
            )}
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
              Payments through MeshPort confirm the order right away. A wallet payment of this exact amount to your address is linked to this order within seconds (if several open orders have the same amount, you'll be asked to pick). You can also use “Check a transaction” below.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={downloadQr} style={{ ...btnGhost, flex: 1 }}><QrCode size={15} /> Save QR</button>
            <button onClick={share} style={{ ...btnGhost, flex: 1 }}><Share2 size={15} /> {qrMode === 'wallet' ? 'Share QR' : 'Share QR & link'}</button>
          </div>
          {intent?.customerUsername && (
            <button onClick={sendInChat} style={btnGhost}><MessageCircle size={15} /> Send to {intent.customerUsername}.arc in chat</button>
          )}
        </>
      )}

      {payments.length > 0 && (
        <Section title="Payments">
          {payments.map(p => (
            <Row key={p.id} icon={<CheckCircle2 size={16} color="var(--success)" />}
              title={`+$${formatAmount(p.amount)} USDC`}
              sub={`${p.customerUsername ? p.customerUsername + '.arc' : short(p.from)} · ${routeLabel(p.chain)} · ${paymentStageLabel(p)}${p.matchedBy === 'watcher' ? ' · direct deposit' : ''}`}
              amountColor="var(--success)" />
          ))}
        </Section>
      )}

      {!done && (
        <>
          <button onClick={() => setVerifyOpen(v => !v)} style={{ ...btnGhost, border: 'none', color: 'var(--text-secondary)' }}>Customer already paid? Check a transaction</button>
          {verifyOpen && (
            <div style={{ ...card, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <select value={vChain} onChange={e => setVChain(e.target.value)} style={input}>
                {Object.entries(CHAIN_LABEL).map(([id, l]) => <option key={id} value={id}>{l}</option>)}
              </select>
              <input value={vHash} onChange={e => setVHash(e.target.value)} placeholder="Transaction hash (0x…)" style={input} />
              <button onClick={verify} disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(vHash.trim())} style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }}>Check payment</button>
            </div>
          )}
          {intent && intent.received === 0 && (
            <button onClick={cancel} disabled={busy} style={{ ...btnGhost, color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 40%, transparent)' }}>Cancel request</button>
          )}
        </>
      )}

      {canComplete && (
        !completeOpen ? (
          <button onClick={() => setCompleteOpen(true)} style={btnGhost}><CheckCircle2 size={15} /> Mark as completed</button>
        ) : (
          <div style={{ ...card, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Mark order #{intent ? orderLabel(intent) : ''} as completed?</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
              Use this when the order was settled another way (cash, a payment you checked yourself…). The customer can't pay it any more.
              {intent && intent.received > 0 && intent.received < intent.amount ? ` $${formatAmount(intent.received)} of $${formatAmount(intent.amount)} was received.` : ''}
            </div>
            <input value={completeNote} onChange={e => setCompleteNote(e.target.value)} maxLength={140} placeholder="Note (optional) — e.g. Paid in cash" style={input} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { setCompleteOpen(false); setCompleteNote('') }} disabled={busy} style={{ ...btnGhost, flex: 1 }}>Back</button>
              <button onClick={complete} disabled={busy} style={{ ...btnPrimary, flex: 2, opacity: busy ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Mark as completed'}</button>
            </div>
          </div>
        )
      )}
    </div>
  )
}

// ── Customer detail ─────────────────────────────────────────────────────────
function CustomerDetail({ keyId, payments, intents, onBack, onRequest, onOpenRequest }: {
  keyId: string; payments: MerchantPayment[]; intents: MerchantIntent[]
  onBack: () => void; onRequest: (customer?: string) => void; onOpenRequest: (code: string) => void
}) {
  const mine = payments.filter(p => (p.customerUsername ? `u:${p.customerUsername}` : `w:${p.from}`) === keyId)
  const username = keyId.startsWith('u:') ? keyId.slice(2) : null
  const name = username ? `${username}.arc` : short(keyId.slice(2))
  const total = mine.reduce((s, p) => s + p.amount, 0)
  const intentById = new Map(intents.map(i => [i.id, i]))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Header title={name} onBack={onBack} />
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ ...card, flex: 1, padding: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 700, textTransform: 'uppercase' }}>Total received</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-primary)', marginTop: 4 }}>${formatAmount(total)}</div>
        </div>
        <div style={{ ...card, flex: 1, padding: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 700, textTransform: 'uppercase' }}>Transactions</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-primary)', marginTop: 4 }}>{mine.length}</div>
        </div>
      </div>
      <button onClick={() => onRequest(username ?? undefined)} style={btnPrimary}>Request payment</button>
      <Section title="Payment history">
        {mine.map(p => {
          const it = intentById.get(p.intentId)
          return (
            <Row key={p.id} icon={<CheckCircle2 size={16} color="var(--success)" />}
              title={`+$${formatAmount(p.amount)} USDC`}
              sub={`${paymentStageLabel(p)} · ${routeLabel(p.chain)}${it?.note ? ' · ' + it.note : ''} · ${timeAgo(p.createdAt)}`}
              onClick={it ? () => onOpenRequest(it.code) : undefined} amountColor="var(--success)" />
          )
        })}
      </Section>
    </div>
  )
}

// ── Bits ───────────────────────────────────────────────────────────────────
function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <button onClick={onBack} aria-label="Back" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)', display: 'flex', padding: 2 }}><ArrowLeft size={20} /></button>
      <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
    </div>
  )
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </div>
  )
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>{label}</div>{children}</div>
}
function Empty({ text }: { text: string }) {
  return <div style={{ padding: 14, textAlign: 'center', fontSize: 13, color: 'var(--text-secondary)', borderRadius: 14, border: '1px dashed var(--border)' }}>{text}</div>
}
function Row({ icon, title, sub, onClick, amountColor }: { icon: React.ReactNode; title: string; sub: string; onClick?: () => void; amountColor?: string }) {
  return (
    <button onClick={onClick} disabled={!onClick}
      style={{ ...card, width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', textAlign: 'left', cursor: onClick ? 'pointer' : 'default' }}>
      <span style={{ width: 32, height: 32, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: amountColor ?? 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
        <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</span>
      </span>
    </button>
  )
}

function CopyRow({ label, value, mono, onCopy }: { label: string; value: string; mono?: boolean; onCopy: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-primary)', wordBreak: 'break-all', marginTop: 2, fontFamily: mono ? 'ui-monospace, monospace' : undefined }}>{value}</div>
      </div>
      <button onClick={onCopy} aria-label={`Copy ${label}`}
        style={{ flexShrink: 0, width: 34, height: 34, borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Copy size={15} />
      </button>
    </div>
  )
}

// ── Needs review: a direct deposit that fits more than one open order ─────
function NeedsReview({ deposits, intents, onDone }: { deposits: UnmatchedDeposit[]; intents: MerchantIntent[]; onDone: () => void }) {
  const { showToastMessage } = useUIStore()
  const [busy, setBusy] = useState<string | null>(null)
  const byCode = new Map(intents.map(i => [i.code, i]))
  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key)
    try { await fn(); showToastMessage(ok, 'success'); onDone() }
    catch (e) { showToastMessage(e instanceof Error ? e.message : 'Something went wrong', 'error') }
    setBusy(null)
  }
  return (
    <Section title="Needs review">
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.4 }}>
        These payments were sent straight to your address and couldn't be linked to one order by themselves. Pick the order each one paid, or mark it as not an order.
      </div>
      {deposits.map(d => (
        <div key={d.id} style={{ ...card, padding: 12, marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)' }}>+${formatAmount(d.amount)} USDC</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{short(d.from)} · {routeLabel(d.chain)} · {timeAgo(d.createdAt)}</div>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--warning)', marginTop: 2 }}>
                {d.reason === 'amount_mismatch' ? "Amount doesn't exactly match an order" : 'Matches more than one order'}
              </div>
            </div>
            <button disabled={!!busy} onClick={() => act(d.id + ':x', () => dismissDeposit(d.id), 'Marked as not an order payment')}
              style={{ ...btnGhost, padding: '6px 10px', fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0 }}>Not an order</button>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {d.candidateCodes.map(code => {
              const i = byCode.get(code)
              return (
                <button key={code} disabled={!!busy} onClick={() => act(d.id + ':' + code, () => assignDeposit(d.id, code), `Linked to order #${i ? orderLabel(i) : code}`)}
                  style={{ ...btnGhost, padding: '7px 10px', fontSize: 12, opacity: busy === d.id + ':' + code ? 0.6 : 1 }}>
                  #{i ? orderLabel(i) : code}{i ? ` · $${formatAmount(Math.max(0, i.amount - i.received))} due` : ''}{i?.customerUsername ? ` · ${i.customerUsername}.arc` : ''}{i?.note ? ` · ${i.note}` : ''}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </Section>
  )
}
