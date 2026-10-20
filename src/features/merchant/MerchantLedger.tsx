// Merchant Ledger (Multichain Hub → Ledger, approved merchants only).
//   • Receive payment → payment request with QR + link (share / send in chat)
//   • Arriving payments (paid on another chain, being moved to Arc)
//   • Customers: totals, count, last payment → per-customer history
//   • Requests: every request and its live status
// All numbers come from merchant_payment_intents / merchant_payments, which
// only the merchant-pay Edge Function changes after verifying on-chain.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Copy, Share2, MessageCircle, QrCode, Search, Users, CheckCircle2 } from 'lucide-react'
import { useAuthStore, useUIStore } from '@/store'
import { useSettingsStore } from '@/store/settingsStore'
import { formatAmount, timeAgo, copyToClipboard } from '@/lib/utils'
import {
  createPaymentRequest, listMyIntents, listMyPayments, subscribeMerchantPayments, paymentLink, orderPayLink, orderChainPayLink,
  cancelPayment, submitPayment, STATUS_LABEL, paymentStageLabel, isArriving, orderLabel, chatCardMessage,
  listUnmatchedDeposits, assignDeposit, dismissDeposit, completeOrder,
  listChainReceipts, getAutoConvert, setAutoConvert, isOwnReceipt, isBridgeReceipt,
  type MerchantIntent, type MerchantPayment, type UnmatchedDeposit, type ChainReceipt, orderKindOf, orderTitle, orderDisplay } from '@/lib/merchantPay'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { HistoryIcon } from '@/components/ui/HistoryRow'
import { useReturnFlash } from '@/hooks/useReturnFlash'
import { PinKeypad } from '@/components/ui/PinKeypad'
import { PopupDim } from '@/components/ui/PopupDim'
import { DesktopTransactionAuthDialog } from '@/components/ui/DesktopTransactionAuthDialog'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { usePopupOpen } from '@/hooks/usePopupOpen'
import { SHEET_PANEL } from '@/lib/motion'
import { ClaimAllScreen, type ClaimAllChain } from './ClaimAllScreen'
import { lastClaimAllAt, CLAIM_ALL_COOLDOWN_MS, CLAIM_ALL_MIN_CHAIN, type ClaimAllStep } from '@/lib/ubClaim'
import { merchantQrChain, MERCHANT_QR_EXTERNAL } from '@/lib/merchantQr'
import { ChainPicker, WalletPaymentDetails } from './MerchantQrPanel'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { ReceiptPopup } from '@/components/ui/ReceiptPopup'
import { explorerTxUrl, arcExplorerTxUrl, ARC_CHAIN_KEY } from '@/lib/chainExplorers'
import { useLeaveGuard } from '@/lib/leaveGuard'
import { drawMeshportQr } from '@/lib/qrLogo'
import { QrCard } from '@/features/business/ui/QrCard'

/** Chat text for a request / bill - the chat renders it as a live card. */
const chatMessageFor = (i: MerchantIntent): string => chatCardMessage(i, formatAmount(i.amount))

const CHAIN_LABEL: Record<string, string> = {
  Arc_Testnet: 'Arc', Ethereum_Sepolia: 'Ethereum', Base_Sepolia: 'Base', Arbitrum_Sepolia: 'Arbitrum', Optimism_Sepolia: 'Optimism',
  Polygon_Sepolia: 'Polygon', Avalanche_Fuji: 'Avalanche', HyperEVM_Testnet: 'HyperEVM', Sei_Testnet: 'Sei', Unichain_Sepolia: 'Unichain',
  Sonic_Testnet: 'Sonic', World_Chain_Sepolia: 'World Chain', Linea_Sepolia: 'Linea', Ink_Testnet: 'Ink', Monad_Testnet: 'Monad', Morph_Testnet: 'Morph', Pharos_Testnet: 'Pharos', Plume_Testnet: 'Plume', Codex_Testnet: 'Codex', Injective_Testnet: 'Injective', XDC_Apothem: 'XDC',
}
const routeLabel = (chain?: string | null) => !chain ? '' : chain === 'Arc_Testnet' ? 'Arc' : `${CHAIN_LABEL[chain] ?? chain.replace(/_/g, ' ')} → Arc`
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`


type View = { kind: 'home' } | { kind: 'request'; code: string } | { kind: 'customer'; key: string }

const card: React.CSSProperties = { background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', border: '1px solid var(--border)', borderRadius: 16 }
const btnPrimary: React.CSSProperties = { padding: '13px 16px', borderRadius: 14, border: '1px solid color-mix(in srgb, black 12%, transparent)', background: 'var(--brand)', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }
const btnGhost: React.CSSProperties = { padding: '11px 14px', borderRadius: 14, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '12px 14px', borderRadius: 14, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 14, outline: 'none' }

/** A chain with USDC waiting, as the Hub's chain list shows it. */
export type ClaimChain = { chainId: string; label: string; balance: number }

export function MerchantLedger({ children, boxStyle, ledgerBalance, ledgerChains, claimChains, onClaimed }: {
  children?: React.ReactNode; boxStyle?: React.CSSProperties
  /** Chains with USDC for Claim All; undefined while scanning. */
  claimChains?: ClaimChain[]; onClaimed?: () => void
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

  const load = useCallback(async () => {
    const [i, p, r] = await Promise.all([listMyIntents(), listMyPayments(), listUnmatchedDeposits().catch(() => [])])
    setIntents(i); setPayments(p); setReview(r); setLoaded(true)
    listChainReceipts().then(setReceipts).catch(() => {})
  }, [])
  // Auto-convert was replaced by Claim All: switch off an old schedule once,
  // so the server no longer books runs for it.
  useEffect(() => {
    getAutoConvert().then(a => { if (a.enabled) void setAutoConvert(false).catch(() => {}) }).catch(() => {})
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => walletAddress ? subscribeMerchantPayments(walletAddress, () => { void load() }) : undefined, [walletAddress, load])
  // Direct deposits are matched by the server every minute - refresh too.
  useEffect(() => { const t = setInterval(() => { void load() }, 60_000); return () => clearInterval(t) }, [load])

  const navigate = useNavigate()
  const box = (el: React.ReactNode) => <div style={boxStyle}>{el}</div>
  // Order payments + payments received straight to the wallet on other chains.
  const allPayments = useMemo(() => withChainReceipts(payments, receipts, walletAddress), [payments, receipts, walletAddress])
  // New payment requests / QR live in Home → Receive.
  const newRequest = (customer?: string) => navigate(`/receive?request=1${customer ? `&customer=${encodeURIComponent(customer)}` : ''}`)
  if (view.kind === 'request') {
    const it = intents.find(i => i.code === view.code)
    return box(<RequestDetail code={view.code} intent={it ?? null} payments={payments.filter(p => p.intentId === it?.id)} onBack={() => setView({ kind: 'home' })} onChanged={load} />)
  }
  if (view.kind === 'customer') {
    return box(<CustomerDetail keyId={view.key} payments={allPayments} intents={intents}
      onBack={() => setView({ kind: 'home' })} onRequest={c => newRequest(c)} onOpenRequest={code => setView({ kind: 'request', code })} />)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {review.length > 0 && box(<NeedsReview deposits={review} intents={intents} onDone={load} />)}
      {box(<LedgerHome loaded={loaded} intents={intents} payments={allPayments} receipts={receipts} chains={children} claimChains={claimChains} onClaimed={onClaimed}
        ledgerBalance={ledgerBalance} ledgerChains={ledgerChains}
        onOpenRequest={code => setView({ kind: 'request', code })} onOpenCustomer={key => setView({ kind: 'customer', key })} />)}
    </div>
  )
}

// ── Home ───────────────────────────────────────────────────────────────────
export type Customer = { key: string; name: string; total: number; count: number; last: string; search: string }

/**
 * Direct payments on other chains (chain receipts that aren't an order's -
 * those are in `payments` already) as payment entries, so Received, the
 * customer list and each customer's history all include them. A mint
 * (faucet / CCTP) has no paying wallet: its entry has no `from`.
 */
export function withChainReceipts(payments: MerchantPayment[], receipts: ChainReceipt[], ownWallet: string | null | undefined): MerchantPayment[] {
  const known = new Set(payments.map(p => `${p.chain}:${(p.txHash ?? '').toLowerCase()}`))
  const usernameOf = (from: string) => payments.find(p => p.from?.toLowerCase() === from.toLowerCase())?.customerUsername ?? null
  const extra: MerchantPayment[] = receipts
    // The merchant's own transfers are listed in the Ledger, but aren't revenue or a customer.
    .filter(r => !r.orderNumber && !isOwnReceipt(r, ownWallet) && !known.has(`${r.chain}:${r.txHash.toLowerCase()}`))
    .map(r => ({
      id: `rcpt_${r.id}`, intentId: '', chain: r.chain, txHash: r.txHash, from: r.from ?? '', amount: r.amount,
      method: 'chain_receipt', status: r.status === 'converted' ? 'collected' : 'confirmed',
      customerUsername: r.from ? usernameOf(r.from) : null, createdAt: r.createdAt, orderNumber: null, matchedBy: null,
    }))
  return [...payments, ...extra].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
export const MINT_SENDER = 'Via bridge (CCTP)'
export const customerKey = (p: Pick<MerchantPayment, 'customerUsername' | 'from'>) => p.customerUsername ? `u:${p.customerUsername}` : `w:${p.from}`

export function customersOf(payments: MerchantPayment[]): Customer[] {
  const map = new Map<string, Customer>()
  for (const p of payments) {
    const key = customerKey(p)
    const name = p.customerUsername ? `${p.customerUsername}.arc` : p.from && !isBridgeReceipt(p) ? short(p.from) : MINT_SENDER
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

type LedgerTab = 'requests' | 'customers' | 'chains'
let lastLedgerTab: LedgerTab = 'chains'

function LedgerHome({ loaded, intents, payments, receipts, chains, claimChains, onClaimed, onOpenRequest, onOpenCustomer, ledgerBalance, ledgerChains }: {
  loaded: boolean; intents: MerchantIntent[]; payments: MerchantPayment[]; chains?: React.ReactNode
  ledgerBalance?: number; ledgerChains?: number
  receipts: ChainReceipt[]; claimChains?: ClaimChain[]; onClaimed?: () => void
  onOpenRequest: (code: string) => void; onOpenCustomer: (key: string) => void
}) {
  // Back from a request or customer: same tab, and that row flashes.
  const listFlash = useReturnFlash('merchant-ledger')
  const [tab, setTabState] = useState<LedgerTab>(() => (listFlash.flashId ? lastLedgerTab : 'chains'))
  const setTab = (t: LedgerTab) => { lastLedgerTab = t; setTabState(t) }
  const walletAddress = useAuthStore(s => s.walletAddress)
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
  const paymentCount = payments.length
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
      icon={<HistoryIcon tone={i.status === 'paid' ? 'in' : i.status === 'failed' ? 'failed' : ['expired', 'cancelled'].includes(i.status) ? 'muted' : 'pending'} icon="receive" />}
      title={`${i.kind === 'invoice' ? 'Bill · ' : ''}$${formatAmount(i.amount)} USDC${i.note ? ' · ' + i.note : ''}`}
      sub={`${orderDisplay(i)} · ${i.customerUsername ? i.customerUsername + '.arc · ' : ''}${i.status === 'paid' && i.completedByMerchant ? 'Completed by you' : STATUS_LABEL[i.status]}${i.sourceChain ? ' · ' + routeLabel(i.sourceChain) : ''} · ${timeAgo(i.createdAt)}`}
      flash={i.id === listFlash.flashId}
      onClick={() => { listFlash.leaving(i.id); onOpenRequest(i.code) }} amountColor={i.status === 'paid' ? 'var(--success)' : undefined} />
  )
  const more = (shown: number, total: number, open: boolean, toggle: () => void) => total > shown || open ? (
    <button onClick={toggle} style={{ ...btnGhost, border: 'none', padding: '6px', color: 'var(--brand-text)', fontSize: 12.5 }}>
      {open ? 'Show less' : `Show all (${total})`}
    </button>
  ) : null

  const reqList = showAllReq ? history : history.slice(0, LIMIT)
  const custList = showAllCust ? customers : customers.slice(0, LIMIT)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Summary - one compact row */}
      <div style={{ ...card, display: 'flex', alignItems: 'stretch' }}>
        {stat('Received', `$${formatAmount(received)}`, `${paymentCount} payment${paymentCount === 1 ? '' : 's'}`)}
        {divider}
        {stat('Open', String(openRequests.length), 'requests', openRequests.length ? 'var(--warning)' : undefined)}
        {divider}
        {stat('Customers', String(allCustomers.length))}
      </div>

      {waitingTotal > 0 && (
        <button onClick={() => setTab('chains')} style={{ ...card, padding: '10px 12px', textAlign: 'left', cursor: 'pointer', borderColor: 'color-mix(in srgb, var(--warning) 35%, var(--border))' }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--warning)' }}>${formatAmount(waitingTotal)} USDC on {ledgerChains ? `${ledgerChains} other chain${ledgerChains === 1 ? '' : 's'}` : 'other chains'}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
            Open Chains to move it to Arc with Claim All
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
              background: tab === id ? 'var(--brand)' : 'transparent', color: tab === id ? '#fff' : 'var(--text-secondary)' }}>
            {text}
          </button>
        ))}
      </div>

      {tab === 'requests' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!loaded ? <SkeletonRows count={4} className="px-0" /> : intents.length === 0 ? (
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
          {!loaded ? <SkeletonRows count={4} className="px-0" /> : customers.length === 0 ? <Empty text={needle ? 'No customer matches this username or address.' : 'Customers who pay you will show here.'} /> : (
            <>
              {custList.map(c => (
                <Row key={c.key} icon={<span style={{ width: 38, height: 38, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--brand) 10%, transparent)' }}><Users size={17} color="var(--brand-text)" /></span>} title={c.name}
                  flash={c.key === listFlash.flashId}
                  sub={`$${formatAmount(c.total)} received · ${c.count} transaction${c.count === 1 ? '' : 's'} · last ${timeAgo(c.last)}`} onClick={() => { listFlash.leaving(c.key); onOpenCustomer(c.key) }} />
              ))}
              {more(LIMIT, customers.length, showAllCust, () => setShowAllCust(v => !v))}
            </>
          )}
        </div>
      )}

      {tab === 'chains' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <ClaimAllCard chains={claimChains} onClaimed={onClaimed} />
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

/**
 * Claim All: every chain's USDC to the Arc balance in one go - the merchant
 * taps it (nothing moves by itself). Offered once every 6 hours; one chain
 * can still be claimed any time from the list below. See merchantClaimAll.
 */
function ClaimAllCard({ chains, onClaimed }: { chains?: ClaimChain[]; onClaimed?: () => void }) {
  const walletAddress = useAuthStore(s => s.walletAddress)
  const storedPasscode = useAuthStore(s => s.passcode)
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const [last, setLast] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [pinOpen, setPinOpen] = useState(false)
  const [pin, setPin] = useState('')
  const [pinError, setPinError] = useState(false)
  const [running, setRunning] = useState(false)
  // Claim All is moving funds on several chains: hold Back / sidebar until it ends.
  useLeaveGuard(running, 'Claim All')
  const [steps, setSteps] = useState<Record<string, ClaimAllStep>>({})
  // The chains of the current run (snapshot - the scan list refreshes under
  // it) and whether its tracking screen is up. Retry re-runs only `retryIds`.
  const [runChains, setRunChains] = useState<ClaimAllChain[]>([])
  const [screenOpen, setScreenOpen] = useState(false)
  const [retryIds, setRetryIds] = useState<string[] | null>(null)
  const navigate = useNavigate()

  useEffect(() => { if (walletAddress) lastClaimAllAt(walletAddress).then(setLast).catch(() => setLast(0)) }, [walletAddress])
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t) }, [])

  const due = (chains ?? []).filter(c => c.balance >= CLAIM_ALL_MIN_CHAIN)
  const total = due.reduce((s, c) => s + c.balance, 0)
  // Admin → Features → Multichain "Claim All wait": off = no wait (testing);
  // its value = hours between Claim Alls (default 6).
  const cooldownOn = useSettingsStore(st => st.isEnabled('merchant_claim_all_cooldown', true))
  const cooldownHours = Number(useSettingsStore(st => st.getValue('merchant_claim_all_cooldown'))) || CLAIM_ALL_COOLDOWN_MS / 3_600_000
  const nextAt = last && cooldownOn ? last + cooldownHours * 3_600_000 : 0
  const waitText = !cooldownOn ? 'Available any time' : `Available every ${cooldownHours} hour${cooldownHours === 1 ? '' : 's'}`
  const ready = last !== null && now >= nextAt

  // `only`: Retry - just the chains that failed in this run (any time, the
  // Claim All wait doesn't apply); otherwise every chain that's due.
  const run = async (passcode?: string, only?: string[]) => {
    if (!walletAddress) return
    const list = only ? runChains.filter(c => only.includes(c.chainId)) : due.map(c => ({ chainId: c.chainId, label: c.label, balance: c.balance }))
    if (list.length === 0) return
    if (only) setSteps(prev => { const next = { ...prev }; only.forEach(id => delete next[id]); return next })
    else { setRunChains(list); setSteps({}) }
    setRunning(true); setScreenOpen(true)
    try {
      let key = useAuthStore.getState().privateKey
      if (!key) {
        const { restorePrivateKey } = await import('@/lib/restoreWallet')
        await restorePrivateKey(passcode, { silent: true }).catch(() => false)
        key = useAuthStore.getState().privateKey
      }
      if (!key) throw new Error('Wallet unavailable - unlock MeshPort and try again')
      const { merchantClaimAll } = await import('@/lib/ubClaim')
      const r = await merchantClaimAll({
        walletAddress, privateKey: key,
        chains: list.map(c => ({ chainId: c.chainId, balance: c.balance })),
        onStep: s => setSteps(prev => ({ ...prev, [s.chainId]: s })),
      })
      if (r.cctp > 0 && !only) setLast(Date.now())
      onClaimed?.()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Claim All failed'
      // Chains that never started show the reason instead of "Waiting".
      setSteps(prev => {
        const next = { ...prev }
        list.forEach(c => { if (!next[c.chainId] || next[c.chainId].state === 'working') next[c.chainId] = { chainId: c.chainId, state: 'error', msg } })
        return next
      })
    }
    setRunning(false)
  }

  const tap = () => {
    if (!ready || running || due.length === 0) return
    setRetryIds(null)
    if (storedPasscode) { setPin(''); setPinError(false); setPinOpen(true) } else void run()
  }
  const retry = (ids: string[]) => {
    if (running || ids.length === 0) return
    setRetryIds(ids)
    if (storedPasscode) { setScreenOpen(false); setPin(''); setPinError(false); setPinOpen(true) } else void run(undefined, ids)
  }
  const confirmPin = async (entered: string) => {
    if (!storedPasscode) return
    const { verifyPasscode } = await import('@/lib/security')
    if (!await verifyPasscode(entered, storedPasscode)) { setPinError(true); setPin(''); return }
    setPinOpen(false); setPin('')
    void run(entered, retryIds ?? undefined)
  }

  const scanning = chains === undefined
  const btnText = running ? 'Claiming…'
    : scanning || last === null ? 'Checking chains…'
    : !ready ? `Next Claim All ${fmtWhen(new Date(nextAt).toISOString())}`
    : due.length === 0 ? 'Nothing to claim'
    : `Claim All · $${formatAmount(total)} USDC`
  const enabled = ready && !running && !scanning && due.length > 0

  const keypad = (
    <PinKeypad value={pin} length={6} error={pinError}
      onChange={v => { setPin(v); setPinError(false) }}
      onComplete={p => { void confirmPin(p) }} />
  )
  const pinAmount = retryIds ? runChains.filter(c => retryIds.includes(c.chainId)).reduce((t, c) => t + c.balance, 0) : total
  const confirmText = pinError ? 'Incorrect passcode. Try again.' : `Confirm ${retryIds ? 'retry' : 'Claim All'} of $${formatAmount(pinAmount)} USDC`
  const hasRun = runChains.length > 0 && Object.keys(steps).length > 0

  return (
    <div style={{ ...card, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Claim All</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.4 }}>
          {`Moves USDC from every chain to your Arc balance through CCTP - no gas needed, MeshPort pays it. ${waitText}; you can still claim one chain at a time below.`}
        </div>
      </div>
      {!scanning && due.length > 0 && (
        <div style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>
          <b>${formatAmount(total)} USDC</b> on {due.map(c => c.label).join(', ')}
        </div>
      )}
      <button onClick={tap} disabled={!enabled}
        style={{ ...btnPrimary, width: '100%', cursor: enabled ? 'pointer' : 'default',
          ...(enabled ? {} : { background: 'color-mix(in srgb, var(--text-primary) 10%, transparent)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }) }}>
        {btnText}
      </button>
      {hasRun && !screenOpen && (
        <button onClick={() => setScreenOpen(true)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--brand-text)', textAlign: 'left' }}>
          {running ? 'Claiming… view progress ›' : 'View last Claim All ›'}
        </button>
      )}

      <AnimatePresence>
        {screenOpen && hasRun && (
          <ClaimAllScreen key="claim-all" chains={runChains} steps={steps} running={running}
            onClose={() => setScreenOpen(false)}
            onRetry={retry}
            onTrack={id => { setScreenOpen(false); navigate(`/multichain?claim=${encodeURIComponent(id)}`, { state: { tab: 'bring', trackClaimId: id } }) }}
            onViewHub={() => { setScreenOpen(false); navigate('/multichain', { state: { tab: 'activity' } }) }} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {pinOpen && (isDesktop ? (
          <DesktopTransactionAuthDialog key="pin" onClose={() => setPinOpen(false)} title={retryIds ? 'Confirm retry' : 'Confirm Claim All'}
            amountLabel={`$${formatAmount(pinAmount)} USDC`} subLabel={pinError ? <span role="alert" style={{ color: 'var(--danger, #D64545)' }}>Incorrect passcode. Try again.</span> : 'To your Arc balance'}>
            {keypad}
          </DesktopTransactionAuthDialog>
        ) : (
          <PinSheet key="pin" onClose={() => setPinOpen(false)} text={confirmText} error={pinError}>{keypad}</PinSheet>
        ))}
      </AnimatePresence>
    </div>
  )
}

/** Mobile passcode sheet, rendered into document.body. */
function PinSheet({ onClose, text, error, children }: { onClose: () => void; text: string; error: boolean; children: React.ReactNode }) {
  usePopupOpen()
  return createPortal(
    <div onClick={e => { e.stopPropagation(); onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'flex-end' }}>
      <PopupDim background="rgba(0,0,0,0.5)" />
      <motion.div onClick={e => e.stopPropagation()} {...SHEET_PANEL}
        style={{ position: 'relative', width: '100%', background: 'var(--surface)', borderRadius: '24px 24px 0 0',
          padding: '20px 20px calc(env(safe-area-inset-bottom, 0px) + 20px)', boxShadow: 'var(--shadow-3)' }}>
        <p style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', margin: 0, textAlign: 'center' }}>Enter Passcode</p>
        <p role={error ? 'alert' : undefined} style={{ fontSize: 12, margin: '6px 0 24px', textAlign: 'center', color: error ? 'var(--danger, #D64545)' : 'var(--text-secondary)' }}>{text}</p>
        {children}
      </motion.div>
    </div>,
    document.body,
  )
}

// ── Request detail (QR / link / status) ─────────────────────────────────────
function RequestDetail({ code, intent, payments, onBack, onChanged }: {
  code: string; intent: MerchantIntent | null; payments: MerchantPayment[]; onBack: () => void; onChanged: () => void
}) {
  const [receiptFor, setReceiptFor] = useState<MerchantPayment | null>(null)
  const payFlash = useReturnFlash()
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const { showToastMessage } = useUIStore()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const link = orderPayLink(code, intent?.orderNumber)
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [vChain, setVChain] = useState(ARC_CHAIN_KEY)
  const [vHash, setVHash] = useState('')
  const [busy, setBusy] = useState(false)

  const walletAddress = useAuthStore(s => s.walletAddress)
  // MeshPort QR: Arc - EIP-681 (address + amount due + Arc) for any wallet,
  // plus the order's pay link for MeshPort's scanner (order, amount fixed).
  // Merchant QR: one of the other networks - ONLY address + amount + network.
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
    drawMeshportQr(canvasRef.current, qrValue, 232).catch(() => {})
  }, [qrValue])

  const message = !intent ? link
    : qrMode === 'wallet' && walletAddress
    ? `Pay $${formatAmount(dueNow)} USDC on ${merchantQrChain(qrChain).label} · ${orderTitle(orderKindOf(intent), orderLabel(intent))}\n${qrValue}`
    : `${orderTitle(orderKindOf(intent), orderLabel(intent))}: $${formatAmount(intent.amount)} USDC${intent.note ? ` · ${intent.note}` : ''}\n${link}`

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
    g.font = '600 24px system-ui, sans-serif'; g.fillStyle = '#444444'; g.fillText(`${orderTitle(orderKindOf(intent), orderLabel(intent))}`, W / 2, 162)
    g.drawImage(qr, (W - 420) / 2, 190, 420, 420)
    g.font = '500 18px system-ui, sans-serif'; g.fillStyle = '#555555'
    g.fillText(qrMode === 'wallet' ? `Scan with any wallet · ${merchantQrChain(qrChain).label} · amount fills in` : 'Scan with MeshPort or any wallet · USDC, any network', W / 2, 650)
    g.font = '500 17px ui-monospace, monospace'; g.fillStyle = '#111111'
    g.fillText(qrMode === 'wallet' ? (walletAddress ?? '') : (link.length > 52 ? link.slice(0, 52) + '…' : link), W / 2, 690)

    const blob: Blob | null = await new Promise(r => c.toBlob(b => r(b), 'image/png'))
    return blob ? new File([blob], `payment-${orderDisplay(intent)}-${merchantQrChain(shownChain).label.toLowerCase()}.png`, { type: 'image/png' }) : null
  }

  const share = async () => {
    const file = await qrImage().catch(() => null)
    if (typeof navigator.share === 'function') {
      try {
        const withFile = file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })
        await navigator.share(withFile
          ? { title: 'Payment request', text: message, files: [file!] }
          // The message already carries the link / QR value - not again as `url` (it showed twice).
          : { title: 'Payment request', text: message })
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
      showToastMessage(v.pending ? 'Not confirmed on-chain yet - try again shortly' : 'Payment checked', v.pending ? 'info' : 'success')
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
      showToastMessage(`${intent ? orderTitle(orderKindOf(intent), orderLabel(intent)) : 'Order'} marked as completed`, 'success')
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
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginTop: 2 }}>{orderTitle(orderKindOf(intent), orderLabel(intent), { paid: intent.status === 'paid' })}</div>
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
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--warning)', marginTop: 2 }}>Overpaid by ${formatAmount(over)} USDC - you may want to refund it</div>
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
            <QrCard subtitle={intent ? `${orderTitle(orderKindOf(intent), orderLabel(intent))} · $${formatAmount(intent.amount)}` : undefined}
              tag={qrMode === 'wallet' ? `${merchantQrChain(qrChain).label} · USDC` : undefined}
              caption={qrMode === 'wallet' ? `Pay on ${merchantQrChain(qrChain).label} - the amount fills in` : 'Scan to pay - the amount is fixed'}>
              <canvas ref={canvasRef} width={232} height={232} style={{ display: 'block' }} />
            </QrCard>
            {qrMode === 'wallet' && walletAddress && dueNow > 0
              ? <WalletPaymentDetails chainId={qrChain} to={walletAddress} amount={dueNow} />
              : <div style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center', maxWidth: 320, lineHeight: 1.45 }}>
                  Scan with MeshPort or any wallet app (MetaMask, OKX, Trust, Coinbase…) - the amount and order are fixed; wallets get Arc, the address and the amount filled in.
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
            <Row key={p.id} icon={<HistoryIcon tone="in" icon="receive" />}
              title={`+$${formatAmount(p.amount)} USDC`} flash={p.id === payFlash.flashId}
              sub={`${p.customerUsername ? p.customerUsername + '.arc' : short(p.from)} · ${routeLabel(p.chain)} · ${paymentStageLabel(p)}${p.matchedBy === 'watcher' ? ' · direct deposit' : ''}`}
              onClick={() => { payFlash.opened(); setReceiptFor(p) }} amountColor="var(--success)" />
          ))}
        </Section>
      )}
      {receiptFor && <MerchantPaymentReceipt p={receiptFor} orderNumber={intent ? orderTitle(orderKindOf(intent), orderLabel(intent)) : null} note={intent?.note ?? null} onClose={() => { payFlash.closed(receiptFor.id); setReceiptFor(null) }} />}

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
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Mark {intent ? orderTitle(orderKindOf(intent), orderLabel(intent)) : 'this order'} as completed?</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
              Use this when the order was settled another way (cash, a payment you checked yourself…). The customer can't pay it any more.
              {intent && intent.received > 0 && intent.received < intent.amount ? ` $${formatAmount(intent.received)} of $${formatAmount(intent.amount)} was received.` : ''}
            </div>
            <input value={completeNote} onChange={e => setCompleteNote(e.target.value)} maxLength={140} placeholder="Note (optional) - e.g. Paid in cash" style={input} />
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
  const [receiptFor, setReceiptFor] = useState<MerchantPayment | null>(null)
  const payFlash = useReturnFlash()
  const mine = payments.filter(p => customerKey(p) === keyId)
  const username = keyId.startsWith('u:') ? keyId.slice(2) : null
  const name = username ? `${username}.arc` : keyId.length > 2 && !isBridgeReceipt({ from: keyId.slice(2) }) ? short(keyId.slice(2)) : MINT_SENDER
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
            <Row key={p.id} icon={<HistoryIcon tone="in" icon="receive" />}
              title={`+$${formatAmount(p.amount)} USDC`} flash={p.id === payFlash.flashId}
              sub={`${paymentStageLabel(p)} · ${routeLabel(p.chain)}${it?.note ? ' · ' + it.note : ''} · ${timeAgo(p.createdAt)}`}
              onClick={() => { payFlash.opened(); setReceiptFor(p) }} amountColor="var(--success)" />
          )
        })}
      </Section>
      {receiptFor && (() => {
        const it = intentById.get(receiptFor.intentId)
        return <MerchantPaymentReceipt p={receiptFor} orderNumber={it ? orderTitle(orderKindOf(it), orderLabel(it)) : null} note={it?.note ?? null}
          onViewOrder={it ? () => { setReceiptFor(null); onOpenRequest(it.code) } : undefined}
          onClose={() => { payFlash.closed(receiptFor.id); setReceiptFor(null) }} />
      })()}
    </div>
  )
}

// A merchant payment reopened as the receiver's receipt ("Payment Received").
// External-chain payments converting via Unified Balance show as processing
// until they reach the Arc balance.
function MerchantPaymentReceipt({ p, orderNumber, note, onViewOrder, onClose }: {
  p: MerchantPayment; orderNumber: string | null; note: string | null
  onViewOrder?: () => void; onClose: () => void
}) {
  const arriving = isArriving(p)
  const onArc = p.chain === ARC_CHAIN_KEY
  const href = onArc ? arcExplorerTxUrl(p.txHash) : explorerTxUrl(p.chain, p.txHash)
  const chainName = onArc ? 'Arc' : (CHAIN_LABEL[p.chain] ?? p.chain.replace(/_/g, ' '))
  const from = p.customerUsername ? `${p.customerUsername.replace(/\.arc$/i, '')}.arc` : short(p.from)
  return (
    <ReceiptPopup
      onClose={onClose}
      status={arriving ? 'pending' : 'success'}
      title={arriving ? 'Payment Arriving' : 'Payment Received'}
      subtitle={<>
        <span style={{ display: 'block', fontSize: 20, fontWeight: 800, color: 'var(--success)', marginBottom: 4 }}>+${formatAmount(p.amount)} USDC</span>
        From {from}{orderNumber ? ` · ${orderNumber}` : ''}
      </>}
      // The header shows the amount, who paid and the order; the title the outcome.
      rows={[
        ...(arriving ? [{ label: 'Status', value: paymentStageLabel(p) }] : []),
        ...(p.txHash ? [{ label: 'Transaction Hash', value: `${p.txHash.slice(0, 6)}…${p.txHash.slice(-4)}` }] : []),
        { label: 'Time', value: new Date(p.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) },
      ]}
      detailRows={[
        { label: 'Route', value: routeLabel(p.chain) || 'Arc' },
        { label: 'Sender wallet', value: short(p.from) },
        ...(p.matchedBy ? [{ label: 'Matched by', value: p.matchedBy === 'watcher' ? 'Direct deposit' : p.matchedBy === 'merchant' ? 'You (checked a transaction)' : 'Customer' }] : []),
        ...(note ? [{ label: 'Note', value: note }] : []),
      ]}
      fullHash={p.txHash || undefined}
      links={p.txHash && href ? [{ title: `View on ${onArc ? 'ArcScan' : chainName}`, explorer: onArc ? 'ArcScan' : chainName, hash: p.txHash, href }] : undefined}
      primaryLabel={onViewOrder ? 'View order' : 'Done'}
      onPrimary={onViewOrder}
    />
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
      <div style={{ display: 'flex', flexDirection: 'column' }}>{children}</div>
    </div>
  )
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>{label}</div>{children}</div>
}
function Empty({ text }: { text: string }) {
  return <div style={{ padding: 14, textAlign: 'center', fontSize: 13, color: 'var(--text-secondary)', borderRadius: 14, border: '1px dashed var(--border)' }}>{text}</div>
}
// A list row like Activity's: no card or divider, the round history icon;
// `flash` = the row you just came back from.
function Row({ icon, title, sub, onClick, amountColor, flash }: { icon: React.ReactNode; title: string; sub: string; onClick?: () => void; amountColor?: string; flash?: boolean }) {
  return (
    <button onClick={onClick} disabled={!onClick} className={flash ? 'mp-last-opened' : undefined}
      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '11px 4px', textAlign: 'left', cursor: onClick ? 'pointer' : 'default',
        background: 'none', border: 'none', color: 'inherit', font: 'inherit' }}>
      {icon}
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
                <button key={code} disabled={!!busy} onClick={() => act(d.id + ':' + code, () => assignDeposit(d.id, code), `Linked to ${i ? orderTitle(orderKindOf(i), orderLabel(i)) : code}`)}
                  style={{ ...btnGhost, padding: '7px 10px', fontSize: 12, opacity: busy === d.id + ':' + code ? 0.6 : 1 }}>
                  {i ? orderDisplay(i) : code}{i ? ` · $${formatAmount(Math.max(0, i.amount - i.received))} due` : ''}{i?.customerUsername ? ` · ${i.customerUsername}.arc` : ''}{i?.note ? ` · ${i.note}` : ''}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </Section>
  )
}
