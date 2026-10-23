// Business tab (business accounts; replaces Rewards in the bottom bar).
// Self-contained: every action opens a Business screen (./screens), nothing
// sends the merchant to another page.
//
//   Overview     today's money, Show QR / Charge, ways to get paid, recent
//                payments, business tools
//   Payments     every merchant payment, by day, with where the money is now
//   Settlements  USDC waiting on other chains and Settle (./settlement: CCTP +
//                claims, MeshPort pays the gas), live progress and history
//
// The UI kit in ./ui was designed with Arc Studio.
import { useLatched } from '@/hooks/useLatched'
import { DesktopTwoColumn } from '@/components/layout/DesktopTwoColumn'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { DESKTOP_QUERY } from '@/lib/motion'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useBackLayer } from '@/lib/backLayers'
import { useBizTerms } from '@/lib/businessCategories'
import { getUserByUsername, getOrCreateConversation } from '@/lib/supabase'
import { ArrowLeft } from 'lucide-react'
import { copyToClipboard } from '@/lib/utils'
import { useAuthStore, useWalletStore } from '@/store'
import { useMerchant, useBusinessTab } from '@/lib/merchant'
import { explorerTxUrl } from '@/lib/chainExplorers'
import { chainLogoSrc } from '@/lib/chainLogos'
import { listMyPayments, listMyIntents, isAskedOrder, listChainReceipts, subscribeMerchantPayments, subscribeChainReceipts, createPaymentRequest, displayOrderNumber, type MerchantPayment, type MerchantIntent } from '@/lib/merchantPay'
import { listStores, activeStoreId, setActiveStoreId, type Store } from '@/lib/businessTeam'
import { StorePicker } from '@/features/merchant/StorePicker'
import { useVoiceAlerts, setVoiceAlerts, speakPayment } from '@/lib/voiceAlerts'
import { useSettlement, useSettlementHistory, chainLabel, claimStage, unlockKey } from './settlement'
import { listMyRefunds, subscribeMyRefunds, refundPayment, chainUsdcBalance, canRefundOnChain, checkRefundableSender, type SenderCheck, REFUND_REASONS, type MerchantRefund, type RefundRoute } from '@/lib/merchantRefunds'
import { mergeSales } from '@/lib/businessSales'
import { groupRefunds, refundedSum, remainingAfter, isFullyRefunded, canRefundMore, netPayments, MIN_REFUND } from '@/lib/refundTotals'
import { makePeriod, inPeriod, inPrevious, periodTrend, savedPeriod, savePeriod, type PeriodId } from './period'
import { useAutoSettle } from './autoSettle'
import { TeamScreen } from './teamScreens'
import { CashOutScreen } from './cashOutScreen'
import { PayoutsScreen } from './payoutsScreen'
import { ToolsScreen, type ToolId } from './toolsScreen'
import { StaffModePage } from './staffMode'
import { ActivityScreen } from './activityScreen'
import { logBusiness } from '@/lib/businessActivity'
import { readArcBalanceOrThrow, notifyExternalBalanceChanged } from '@/blockchain/BlockchainManager'
import { refreshBalancesAfterTx } from '@/lib/balanceRefresh'
import { useUIStore } from '@/store'
import { PinSheet } from '@/components/ui/PinSheet'
import { DesktopHistoryPanel, DesktopHistoryEmpty, DesktopHistorySkeleton } from '@/components/ui/DesktopHistoryPanel'
import { RequestMaker, ShopQrScreen, ReceiveScreen, RequestsList, CustomersScreen, ReportsScreen, ProfileScreen, ReceiptScreen, HelpScreen } from './screens'
import {
  BusinessHeader, SetupBanner, HubView, LockedHubView, PaymentsView, PaymentDetailSheet, PaymentRow,
  SettlementsView, SettleProgressSheet, VoiceSheet, RefundSheet, TrendChip,
  DateRangeSheet, PeriodSheet, ArcBalanceCard, AutoSettleCard, SettleDueSheet, ScreenLevel, PushLayer, useHubShift,
  type BusinessTab, type Payment, type VerificationStatus, type SettleProgressRow,
} from './ui'

type ScreenId = 'qr' | 'receive' | 'customers' | 'reports' | 'profile' | 'receipt' | 'help' | 'cashout' | 'team' | 'payouts' | 'tools' | 'activity'
/** Screens a link (?screen=) can open - all but a payment's receipt. */
const LINKABLE: ScreenId[] = ['qr', 'receive', 'customers', 'reports', 'profile', 'help', 'cashout', 'team', 'payouts', 'tools', 'activity']
const linkedScreenOf = (q: URLSearchParams): ScreenId | null => {
  const v = q.get('screen') as ScreenId | null
  return v && LINKABLE.includes(v) ? v : null
}

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const who = (p: MerchantPayment) => p.method === 'own_transfer' ? 'Your transfer'
  : p.customerUsername ? `${p.customerUsername}.arc`
  : /^0x0{40}$/i.test(p.from) ? 'A bridge' : `${p.from.slice(0, 6)}…${p.from.slice(-4)}`
const inWords = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

// What the Business tab last showed, per wallet: reopening the tab shows it at
// once and refreshes quietly, instead of a loading skeleton every visit while
// payments, orders, stores and refunds load again.
const bizCache = new Map<string, { raw: MerchantPayment[]; intents: MerchantIntent[] | null; stores: Store[]; refunds: MerchantRefund[] }>()

/** Business accounts get their Business tab; staff of a business get staff mode. */
export function BusinessPage() {
  const business = useBusinessTab()
  const { loaded } = useMerchant()
  // Wait for the account type before choosing (no flash of staff mode).
  if (!business && !loaded) return <div className="h-full bg-bg" />
  return business ? <OwnerBusinessPage /> : <StaffModePage />
}

function OwnerBusinessPage() {
  const location = useLocation()
  const query = new URLSearchParams(location.search)
  const { isMerchant, status, application, storeName: accountStoreName } = useMerchant()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const username = useAuthStore(s => s.username)
  const userAvatar = useAuthStore(s => s.user?.avatar ?? null)
  const voice = useVoiceAlerts()

  const [tab, setTab] = useState<BusinessTab>(() => {
    if (query.get('claim')) return 'settlements'
    const t = (location.state as { btab?: BusinessTab } | null)?.btab ?? query.get('tab')
    return t === 'payments' || t === 'settlements' ? t : 'overview'
  })

  const toast = useUIStore(s => s.showToastMessage)
  const navigate = useNavigate()
  const myUserId = useAuthStore(s => s.user?.id)
  const openChat = async (customer: string) => {
    try {
      const other = await getUserByUsername(customer)
      if (!other || !myUserId) throw new Error('Could not find this customer')
      const { id, error } = await getOrCreateConversation(myUserId, other.id)
      if (error || !id) throw new Error('Could not open the chat')
      const { cacheOtherUser } = await import('@/features/chat/ChatPage')
      cacheOtherUser(id, other)
      navigate(`/chat/${id}`)
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not open the chat', 'error') }
  }

  // ── Payments and refunds (live; the pop-up and voice alert for a new
  // payment come from PaymentReceivedWatcher, on every screen) ──────────
  const cached = walletAddress ? bizCache.get(walletAddress) : undefined
  const [raw, setRaw] = useState<MerchantPayment[]>(() => cached?.raw ?? [])
  const [loaded, setLoaded] = useState(() => !!cached)
  // What the business was paid: order payments (requests, bills, Shop QR -
  // on Arc or another chain), every USDC receipt on another chain (even with
  // no order: sent straight to the address, a bridge, ...; 'direct', counted),
  // and the owner's own transfers between chains ('own_transfer', shown but
  // never counted). USDC sent straight to the wallet ON ARC with no order
  // isn't a sale: it stays a plain receive in Activity. (A direct transfer of
  // exactly an open order's amount is matched to that order by the watcher.)
  const seenReceipts = useRef<Set<string> | null>(null)
  const load = useCallback(async () => {
    const [orders, rcpts] = await Promise.all([listMyPayments(500), listChainReceipts(300).catch(() => null)])
    const receipts = rcpts ?? []
    // USDC just landed on another chain: re-read that chain's balance at once
    // (the "to settle" figure and Settle all), like Home does for Arc.
    if (rcpts) {
      const key = (r: { chain: string; txHash: string }) => `${r.chain}:${r.txHash.toLowerCase()}`
      if (seenReceipts.current && walletAddress) {
        for (const r of rcpts) if (!seenReceipts.current.has(key(r)) && Date.now() - Date.parse(r.createdAt) < 10 * 60_000) notifyExternalBalanceChanged(r.chain, walletAddress)
      }
      seenReceipts.current = new Set(rcpts.map(key))
    }
    setRaw(mergeSales(orders, receipts, walletAddress)); setLoaded(true)
  }, [walletAddress])
  useEffect(() => { void load() }, [load])
  useEffect(() => (walletAddress ? subscribeMerchantPayments(walletAddress, () => { void load() }) : undefined), [walletAddress, load])
  // Other-chain receipts: live too (falls back to the 30 s refresh below).
  useEffect(() => (walletAddress ? subscribeChainReceipts(walletAddress, () => { void load() }) : undefined), [walletAddress, load])
  // Safety net if the live feeds drop - refresh while the tab is open.
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 30_000)
    return () => clearInterval(t)
  }, [load])
  const [refunds, setRefunds] = useState<MerchantRefund[]>(() => cached?.refunds ?? [])
  const loadRefunds = useCallback(() => listMyRefunds().then(setRefunds).catch(() => {}), [])
  useEffect(() => { void loadRefunds(); return subscribeMyRefunds(() => { void loadRefunds() }) }, [loadRefunds])
  // A payment can be refunded several times (never more than it in total):
  // it counts for what the business kept, and is "refunded" only when all of
  // it went back.
  const refundsOf = useMemo(() => groupRefunds(refunds), [refunds])
  const refundedOf = useCallback((id: string) => refundedSum(refundsOf.get(id)), [refundsOf])
  const kept = useCallback((p: MerchantPayment) => remainingAfter(p.amount, refundedOf(p.id)), [refundedOf])
  const refundedIds = useMemo(() => new Set([...refundsOf.keys()].filter(id => {
    const p = raw.find(x => x.id === id); return !p || isFullyRefunded(p.amount, refundedOf(id))
  })), [refundsOf, raw, refundedOf])
  /** Payments with refunds taken off (fully refunded ones dropped). */
  const netOf = useCallback((list: MerchantPayment[]) => netPayments(list.filter(p => p.method !== 'own_transfer'), refundedOf), [refundedOf])

  // ── Stores (which store this device works as - always one; mixing every
  // store's numbers together confused owners) ─────────────────────────────
  const [stores, setStores] = useState<Store[]>(() => cached?.stores ?? [])
  const [storeId, setStoreId] = useState<string | null>(activeStoreId)
  const [intents, setIntents] = useState<MerchantIntent[] | null>(() => cached?.intents ?? null)
  useEffect(() => {
    if (walletAddress && loaded) bizCache.set(walletAddress, { raw, intents, stores, refunds })
  }, [walletAddress, loaded, raw, intents, stores, refunds])
  const intentStore = useMemo(() => new Map((intents ?? []).map(i => [i.id, i.storeId ?? null] as const)), [intents])
  // Other-chain receipts carry the order number, not the order id.
  const orderStore = useMemo(() => new Map((intents ?? []).filter(i => i.orderNumber).map(i => [i.orderNumber!, i.storeId ?? null] as const)), [intents])
  const [periodSheet, setPeriodSheet] = useState(false)
  const [payView, setPayView] = useState<'payments' | 'requests'>('payments')
  useEffect(() => { if (tab !== 'payments') setPayView('payments') }, [tab])
  const [payFilter, setPayFilter] = useState<'all' | 'refunded'>('all')
  useEffect(() => { listStores().then(setStores).catch(() => {}) }, [])
  const reloadIntents = useCallback(() => { listMyIntents(500).then(setIntents).catch(() => setIntents(l => l ?? [])) }, [])
  useEffect(reloadIntents, [raw.length, tab, reloadIntents])
  // The picked store, else the main store (also after its store was removed).
  const activeStore = stores.find(s => s.id === storeId) ?? stores.find(s => s.isDefault) ?? stores[0] ?? null
  // Requests and the Shop QR belong to the store being viewed.
  const qrStore = activeStore
  const pickStore = (id: string) => { setStoreId(id); setActiveStoreId(id) }
  const storePickList = useMemo(() => [...stores].sort((a, b) => Number(b.isDefault) - Number(a.isDefault)).map(st => ({ id: st.id, name: st.name, isDefault: st.isDefault })), [stores])
  // A payment's store is its order's store; anything without one (taken
  // before stores, other-chain receipts, plain transfers) is the main store's.
  const mainStoreId = stores.find(s => s.isDefault)?.id ?? stores[0]?.id ?? null
  const storeOf = useCallback((p: MerchantPayment) => (p.intentId ? intentStore.get(p.intentId) : p.orderNumber ? orderStore.get(p.orderNumber) : null) ?? mainStoreId, [intentStore, orderStore, mainStoreId])
  const inStore = (i: MerchantIntent, id: string) => (i.storeId ?? mainStoreId) === id
  const storeRaw = useMemo(() => activeStore ? raw.filter(p => storeOf(p) === activeStore.id) : raw, [raw, activeStore, storeOf])
  const paymentsByStore = useMemo(() => {
    const m = new Map<string, { total: number; count: number }>()
    for (const p of netOf(raw)) { const sid = storeOf(p); if (!sid) continue; const v = m.get(sid) ?? { total: 0, count: 0 }; v.total += p.amount; v.count++; m.set(sid, v) }
    return m
  }, [raw, storeOf, netOf])

  // ── Date filter (Overview, Payments, Settlements) ─────────────────────
  const [periodSel, setPeriodSel] = useState(savedPeriod)
  const [rangeSheet, setRangeSheet] = useState<{ from: string; to: string } | null>(null)
  const rangeShown = useLatched(rangeSheet)
  const choosePeriod = (v: { id: PeriodId; from: string; to: string }) => { setPeriodSel(v); savePeriod(v) }
  const period = useMemo(() => makePeriod(periodSel.id, periodSel), [periodSel])
  const periodRaw = useMemo(() => storeRaw.filter(p => inPeriod(p.createdAt, period)), [storeRaw, period])
  // Reports → Compare stores: each store's own sales in the period.
  const storeCompare = useMemo(() => stores.map(st => {
    const list = netOf(raw.filter(p => storeOf(p) === st.id && inPeriod(p.createdAt, period)))
    return { id: st.id, name: st.name, isDefault: st.isDefault, total: list.reduce((t, p) => t + p.amount, 0), count: list.length }
  }), [stores, raw, storeOf, netOf, period])

  // ── Settlements ───────────────────────────────────────────────────────
  const settle = useSettlement()
  const { chains } = settle
  const history = useSettlementHistory()
  const waitingOn = new Set((chains ?? []).map(c => c.id))

  // A payment on another chain is "to settle" while that chain still holds USDC.
  const toRow = (p: MerchantPayment): Payment => ({
    id: p.id, from: who(p), amount: money(p.amount), chainLabel: chainLabel(p.chain), chainLogo: chainLogoSrc(p.chain),
    time: p.createdAt, order: p.orderNumber ? displayOrderNumber(p.orderNumber) : undefined, wallet: p.from, late: !!p.late, blocked: !!p.screenFlag,
    status: refundedIds.has(p.id) ? 'refunded' as const
      : p.chain !== 'Arc_Testnet' && p.status !== 'collected' && waitingOn.has(p.chain) ? 'to_settle' as const : 'received' as const,
    partlyRefunded: !refundedIds.has(p.id) && refundedOf(p.id) > 0 ? money(refundedOf(p.id)) : undefined,
  })
  const payments: Payment[] = useMemo(() => periodRaw.map(toRow), [periodRaw, chains, refundedOf, refundedIds])
  // Payments screen: every payment, grouped by day (Today, Yesterday… headers).
  const payList: Payment[] = useMemo(() => storeRaw.map(toRow), [storeRaw, chains, refundedOf, refundedIds])

  const today = useMemo(() => {
    const t = netOf(periodRaw)
    const total = t.reduce((s, p) => s + p.amount, 0)
    const onArc = t.filter(p => p.chain === 'Arc_Testnet').reduce((s, p) => s + p.amount, 0)
    return { total, count: t.length, average: t.length ? total / t.length : 0, customers: new Set(t.map(who)).size, onArc }
  }, [periodRaw, netOf])
  const trend = useMemo(() => periodTrend(today.total,
    netOf(storeRaw.filter(p => inPrevious(p.createdAt, period))).reduce((s, p) => s + p.amount, 0)), [today.total, storeRaw, period, netOf])
  const refundedInPeriod = refunds.filter(r => inPeriod(r.createdAt, period) && (!activeStore || storeRaw.some(p => p.id === r.paymentId)))
  const arcBalance = useWalletStore(s => s.balance)
  // The Arc balance is read here too (on open, when the app is back in front,
  // after a settle arrives, a refund, or leaving Cash out / Payouts) - not only
  // by Home's poll. Same reads as Home; a failed read keeps the shown balance.
  const refreshArc = useCallback((afterTx = false) => {
    if (!walletAddress) return
    if (afterTx) { refreshBalancesAfterTx(walletAddress); return }
    readArcBalanceOrThrow(walletAddress, 'USDC').then(b => {
      if (useAuthStore.getState().walletAddress === walletAddress) useWalletStore.getState().setBalance(b)
    }).catch(() => {})
  }, [walletAddress])
  useEffect(() => {
    refreshArc()
    const onFront = () => { if (document.visibilityState === 'visible') refreshArc() }
    document.addEventListener('visibilitychange', onFront)
    window.addEventListener('focus', onFront)
    return () => { document.removeEventListener('visibilitychange', onFront); window.removeEventListener('focus', onFront) }
  }, [refreshArc])
  const settledArrived = settle.run.filter(r => r.stage === 'arrived').length
  useEffect(() => { if (settledArrived > 0) refreshArc(true) }, [settledArrived, refreshArc])
  const autoSettle = useAutoSettle(settle.total)

  // ── Sheets ────────────────────────────────────────────────────────────
  const [detail, setDetail] = useState<Payment | null>(null)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [progressOpen, setProgressOpen] = useState(false)
  const [historyId, setHistoryId] = useState<string | null>(() => query.get('claim'))
  const [pin, setPin] = useState<{ kind: 'settle'; retry?: string[] } | { kind: 'one'; chainId: string } | { kind: 'refund' } | null>(null)
  const pinShown = useLatched(pin)
  const [pinError, setPinError] = useState<string | undefined>()
  const [pinValue, setPinValue] = useState('')
  const askPin = (p: NonNullable<typeof pin>) => { setPinError(undefined); setPinValue(''); setPin(p) }

  // Open screens, bottom to top: a screen opened from another one (Business
  // tools → Stores & staff, Stores → a store's QR, a payment → its receipt)
  // pushes over it, and back uncovers the one beneath - like pages.
  // ?screen=<id> opens that screen directly (More → Business Insights opens
  // Reports; search opens any of them). ?tab=payments / settlements opens
  // Manage orders / Manage money.
  const linkedScreen = useRef<ScreenId | null>(linkedScreenOf(query))
  const [stack, setStack] = useState<ScreenId[]>(() => query.get('apply') ? ['profile'] : linkedScreen.current ? [linkedScreen.current] : [])
  const screen = stack.length ? stack[stack.length - 1] : null
  // Back from Cash out or Payouts: USDC may have moved (escrow, staff pay).
  const prevScreen = useRef(screen)
  useEffect(() => {
    if ((prevScreen.current === 'cashout' || prevScreen.current === 'payouts') && screen !== prevScreen.current) refreshArc(true)
    prevScreen.current = screen
  }, [screen, refreshArc])
  // Until MeshPort approves the business, only the apply banner, the
  // application (Business profile) and Help are open.
  const locked = !isMerchant
  // Labels follow the business's category (a café has guests, a freelancer invoices).
  const terms = useBizTerms()
  useEffect(() => {
    if (!locked) return
    if (tab !== 'overview') setTab('overview')
    if (stack.some(id => id !== 'profile' && id !== 'help')) setStack([])
  }, [locked, tab, stack])
  // A link while Business is already open (search from the desktop header).
  const lastSearch = useRef(location.search)
  useEffect(() => {
    if (location.search === lastSearch.current) return
    lastSearch.current = location.search
    const q = new URLSearchParams(location.search)
    const id = linkedScreenOf(q)
    if (id) { linkedScreen.current = id; setStack([id]) }
    const t = q.get('tab')
    if (t === 'payments' || t === 'settlements') { setStack([]); setTab(t) }
  }, [location.search])
  const open = (id: ScreenId) => () => setStack([id])
  const close = () => setStack([])
  const back = () => {
    // Opened from Home's More → Business Insights: Back returns Home (like
    // Back on any tab), not to the Business overview it never showed.
    if (linkedScreen.current && stack.length === 1 && stack[0] === linkedScreen.current) {
      linkedScreen.current = null
      setStack([])
      navigate('/', { replace: true })
      return
    }
    setStack(s => s.slice(0, -1))
  }
  /** Opened from the screen on top: pushes over it, back returns to it. */
  const child = (id: ScreenId) => setStack(s => [...s.filter(x => x !== id), id])
  /** Where a screen sits in the stack (BusinessScreen reads it). */
  const level = (id: ScreenId, children: ReactNode) => {
    const i = stack.indexOf(id)
    return <ScreenLevel.Provider value={{ level: Math.max(0, i), covered: i >= 0 && i < stack.length - 1 }}>{children}</ScreenLevel.Provider>
  }

  const beginSettle = (retry?: string[]) => {
    if (settle.running) { setProgressOpen(true); return }
    // Settle all once per cooldown (retrying failed chains is part of the same run).
    if (!retry && !settle.ready) { setTab('settlements'); return }
    if (settle.needsPasscode) { askPin({ kind: 'settle', retry }); return }
    setProgressOpen(true)
    logSettle(retry)
    void settle.settle(undefined, retry)
  }
  // Activity log: what Settle is moving, by chain.
  const logSettle = (retry?: string[], chainId?: string) => {
    const list = chainId ? (chains ?? []).filter(c => c.id === chainId) : retry ? (chains ?? []).filter(c => retry.includes(c.id)) : settle.due
    void logBusiness('settle_run', { target: list.map(c => chainLabel(c.id)).join(', ') || null, amount: list.reduce((t, c) => t + c.balance, 0) })
  }
  const onPin = async (code: string) => {
    if (!await settle.checkPasscode(code)) { setPinValue(''); setPinError('Incorrect passcode. Try again.'); return }
    const p = pin
    setPin(null)
    if (p?.kind === 'refund') { void runRefund(code); return }
    if (p?.kind === 'one') { setProgressOpen(true); logSettle(undefined, p.chainId); void settle.settleOne(p.chainId, code); return }
    setProgressOpen(true)
    logSettle(p?.kind === 'settle' ? p.retry : undefined)
    void settle.settle(code, p?.kind === 'settle' ? p.retry : undefined)
  }

  /** Settle one chain (Settlements → On each chain → Settle). */
  const beginSettleOne = (chainId: string) => {
    if (settle.running) { setProgressOpen(true); return }
    if (settle.needsPasscode) { askPin({ kind: 'one', chainId }); return }
    setProgressOpen(true)
    logSettle(undefined, chainId)
    void settle.settleOne(chainId)
  }

  // ── Refund (signed on this device) ────────────────────────────────────
  // Always back to the wallet on the chain the payment came in on: an Arc
  // payment through MeshPortRefunds on Arc; another chain's from the USDC
  // still there, or from Arc by CCTP to that chain - never to Arc.
  const [refundFor, setRefundFor] = useState<MerchantPayment | null>(null)
  const refundId = useRef<string | null>(null)
  const [refundReason, setRefundReason] = useState(REFUND_REASONS[0])
  const [refundNote, setRefundNote] = useState('')
  const [refundDest, setRefundDest] = useState<RefundRoute>('arc')
  // USDC still on the payment's chain (the refund comes from there when it can).
  const [chainLeft, setChainLeft] = useState<number | null>(null)
  const [refundBusy, setRefundBusy] = useState(false)
  const [refundError, setRefundError] = useState<string>()
  /** `amount` prefills a part (e.g. the extra on an overpaid order); never more than what's left. */
  const openRefund = (p: MerchantPayment, amount?: number) => {
    const left = kept(p)
    setRefundFor(p); refundId.current = p.id; setRefundAmount((Math.floor(Math.min(amount ?? left, left) * 100 + 1e-6) / 100).toFixed(2)); setRefundReason(REFUND_REASONS[0]); setRefundNote(''); setRefundError(undefined)
    // Paid on another chain: refund from the USDC still on that chain.
    setChainLeft(null)
    if (p.chain === 'Arc_Testnet') { setRefundDest('arc'); return }
    setRefundDest('chain')
    if (!walletAddress) return
    chainUsdcBalance(p.chain, walletAddress).then(b => {
      if (refundId.current !== p.id) return
      setChainLeft(b)
      if (b !== null && b < Math.min(amount ?? left, left) && canRefundOnChain(p.chain)) setRefundDest('origin')
    })
  }
  const [refundAmount, setRefundAmount] = useState('')
  // What can still go back on the payment being refunded.
  const refundLeft = refundFor ? kept(refundFor) : 0
  // What the refund / passcode / date sheets show while they slide away -
  // reading the live values they went blank or changed title as they closed.
  const refundShown = useLatched(refundFor)
  const refundShownLeft = refundShown ? kept(refundShown) : 0
  const confirmRefund = () => {
    if (settle.needsPasscode) { askPin({ kind: 'refund' }); return }
    void runRefund()
  }
  const runRefund = async (passcode?: string) => {
    if (!refundFor) return
    setRefundBusy(true); setRefundError(undefined)
    try {
      const key = await unlockKey(passcode)
      const reason = (refundNote.trim() ? `${refundReason}: ${refundNote.trim()}` : refundReason).slice(0, 140)
      const amount = Number(refundAmount)
      if (!(amount + 1e-9 >= MIN_REFUND) || amount > refundLeft + 1e-9) throw new Error(`Enter ${money(MIN_REFUND)} to ${money(refundLeft)}`)
      const route: RefundRoute = refundFor.chain === 'Arc_Testnet' ? 'arc' : refundDest === 'origin' ? 'origin' : 'chain'
      await refundPayment({ paymentId: refundFor.id, customer: refundFor.from, amount, reason, privateKey: key, route, chain: refundFor.chain, remaining: refundLeft })
      await loadRefunds()
      refreshArc(true)
      toast(`Refunded ${money(amount)} to ${who(refundFor)} on ${chainLabel(refundFor.chain)}`, 'success')
      setRefundFor(null)
    } catch (e) { setRefundError(e instanceof Error ? e.message : 'Refund failed') }
    setRefundBusy(false)
  }
  // Not enough USDC on the payment's chain for the route picked.
  const refundShort = !!refundFor && refundFor.chain !== 'Arc_Testnet' && refundDest === 'chain' && chainLeft !== null
    && chainLeft < (Number(refundAmount) || refundLeft) - 1e-9
  const refundBlocked = refundShort && refundFor ? (canRefundOnChain(refundFor.chain)
    ? `Not enough USDC on ${chainLabel(refundFor.chain)} - pick From Arc to send it there`
    : `Not enough USDC on ${chainLabel(refundFor.chain)} - add some to refund`) : undefined
  const [receiptFor, setReceiptFor] = useState<MerchantPayment | null>(null)

  // Refund only to a person's own wallet: checked on the chain it was paid on.
  const [sender, setSender] = useState<{ id: string; check: SenderCheck | null } | null>(null)
  useEffect(() => {
    const p = detail ? raw.find(x => x.id === detail.id) : undefined
    if (!p) { setSender(null); return }
    let live = true
    // Your own transfer, or a direct receive (no order to refund against):
    // no Refund here - send it back with Pay.
    if (p.method === 'own_transfer') { setSender({ id: p.id, check: { refundable: false, reason: 'Your own transfer from another chain - not a customer payment.' } }); return }
    if (p.method === 'direct') { setSender({ id: p.id, check: { refundable: false, reason: 'A direct transfer to your wallet. To give it back, send it with Pay.' } }); return }
    // Screening: a flagged sender (USDC blocklist, sanctions, frozen, high-risk) can't be refunded.
    if (p.screenFlag) { setSender({ id: p.id, check: { refundable: false, reason: "This address failed compliance screening, so it can't be refunded. Don't ship goods; contact support." } }); return }
    setSender({ id: p.id, check: null })
    checkRefundableSender(p.chain, p.from).then(check => { if (live) setSender({ id: p.id, check }) })
    return () => { live = false }
  }, [detail?.id])

  // ── Labels ────────────────────────────────────────────────────────────
  const scanning = chains === undefined || !settle.checked
  const settleLabel = scanning ? 'Checking chains…'
    : settle.running ? 'Settling…'
    : !settle.ready ? `Settle all again in ${inWords(settle.nextAt - Date.now())}`
    : settle.due.length === 0 ? 'Nothing to settle'
    : `Settle all · ${money(settle.total)} to Arc`
  const settleNote = `Moves your USDC to Arc - MeshPort pays the gas.${settle.waitHours ? ` Settle all once every ${settle.waitHours} hour${settle.waitHours === 1 ? '' : 's'}; settle one chain any time below.` : ' You can also settle one chain at a time below.'}`

  const handle = `${application?.username || username || 'store'}.arc`
  // The business is its username; the name set in Business profile (or one
  // from an older application) is shown when there is one.
  const appliedName = application?.businessName && !/\.arc$/i.test(application.businessName) ? application.businessName : null
  const namedStore = accountStoreName || appliedName || null
  const storeName = namedStore || handle
  const storeInText = namedStore || 'your business'
  const headerStatus: VerificationStatus = isMerchant ? 'verified' : status === 'pending' ? 'review' : 'unverified'

  const banner = isMerchant ? undefined
    : status === 'pending'
      ? <SetupBanner tone="warning" title="Business account under review" text={`We're reviewing ${storeInText}. You'll get a notification when it's approved.`} action="View application" onAction={open('profile')} />
      : status === 'rejected' || status === 'revoked'
        ? <SetupBanner tone="danger" title={status === 'revoked' ? 'Merchant access removed' : 'Business account not approved'} text={application?.reviewNote || 'Check the details and send it again.'} action="Apply again" onAction={open('profile')} />
        : <SetupBanner tone="brand" title="Apply for business approval" text={`Send ${storeInText} for review. Payments, orders and business tools turn on once MeshPort approves it.`} action="Apply for approval" onAction={open('profile')} />

  // History rows from claims; a tapped one opens in the progress sheet.
  const historyItems = (history ?? []).slice(0, 30).map(c => ({
    id: c.id, amount: money(c.arrivedAmount ?? c.amount), chainLabels: [chainLabel(c.sourceChain)], when: c.createdAt,
    status: c.status === 'completed' ? 'completed' as const : c.status === 'failed' ? 'failed' as const : 'in_progress' as const,
  }))
  const historyClaim = historyId ? (history ?? []).find(c => c.id === historyId) : undefined
  const progressRows: SettleProgressRow[] = progressOpen
    ? settle.run.map(r => ({ id: r.id, label: r.label, logo: r.logo, amount: money(r.balance), stage: r.stage, message: r.message }))
    : historyClaim ? [{ id: historyClaim.id, label: chainLabel(historyClaim.sourceChain), logo: chainLogoSrc(historyClaim.sourceChain),
        amount: money(historyClaim.arrivedAmount ?? historyClaim.amount), stage: claimStage(historyClaim.status), message: historyClaim.error ?? undefined }]
    : []
  const failedIds = settle.run.filter(r => r.stage === 'failed').map(r => r.id)

  // Open and partly paid orders (Manage orders → Open / Partly paid), in the store being viewed.
  const pending = useMemo(() => {
    if (!intents) return null
    const now = Date.now()
    const live = intents.filter(i => isAskedOrder(i) && (i.status === 'pending' || i.status === 'partially_paid')
      && (!i.expiresAt || Date.parse(i.expiresAt) > now) && (!activeStore || inStore(i, activeStore.id)))
    return { count: live.length, due: live.reduce((t, i) => t + Math.max(0, i.amount - i.received), 0) }
  }, [intents, activeStore, mainStoreId])
  const openOrders = () => { setPayView('requests'); setTab('payments') }
  // Still owed by named customers (credit ledger), for the Customers row.
  const pendingCredit = useMemo(() => (intents ?? []).filter(i => i.customerUsername && (i.status === 'pending' || i.status === 'partially_paid')
    && (!i.expiresAt || Date.parse(i.expiresAt) > Date.now()) && (!activeStore || inStore(i, activeStore.id)))
    .reduce((t, i) => t + Math.max(0, i.amount - i.received), 0), [intents, activeStore, mainStoreId])

  // Order → its payments (badges and refunds on Manage orders).
  const paymentsByIntent = useMemo(() => {
    const m = new Map<string, MerchantPayment[]>()
    for (const p of raw) if (p.intentId) m.set(p.intentId, [...(m.get(p.intentId) ?? []), p])
    return m
  }, [raw])
  // Refund extra / refund a payment to a cancelled order: same checks as the payment's Refund.
  const refundFromOrder = async (p: MerchantPayment, amount: number) => {
    if (!canRefundMore(p.amount, refundedOf(p.id))) { toast('This payment is already fully refunded', 'error'); return }
    if (p.screenFlag) { toast('This address failed compliance screening - contact support', 'error'); return }
    const check = await checkRefundableSender(p.chain, p.from).catch(() => null)
    if (!check?.refundable) { toast(check?.reason ?? 'Could not check who sent this payment', 'error'); return }
    openRefund(p, amount)
  }

  const rawDetail = detail ? raw.find(p => p.id === detail.id) : undefined
  const detailRefunds = detail ? refundsOf.get(detail.id) ?? [] : []
  const detailCanRefund = !!rawDetail && canRefundMore(rawDetail.amount, refundedOf(rawDetail.id))
  // The payer's history with this business, for the detail's customer card.
  const detailCustomer = useMemo(() => {
    if (!rawDetail) return undefined
    const key = (p: MerchantPayment) => p.customerUsername ? p.customerUsername.toLowerCase() : p.from.toLowerCase()
    const mine = netOf(raw.filter(p => key(p) === key(rawDetail)))
    return { payments: mine.length, total: money(mine.reduce((s, p) => s + p.amount, 0)) }
  }, [rawDetail, raw, netOf])

  // Opening a sub-view (Manage orders / Manage money) now reads like opening
  // any other page: the overview hub stays mounted and parallaxes left (the
  // "old page moves -28%" half of the app's shared page push), while the
  // sub-tab slides the full width in from the right over a dim veil with the
  // same edge shadow - the exact PageTransition / ScreenPush look. (Screen
  // overlays below already supply this themselves.)
  const subOpen = tab !== 'overview'
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  // Desktop: screens fade in the content area (no sliding), nothing shifts.
  const hubCovered = !isDesktop && (!!screen || subOpen)
  // The hub (and the bottom tab bar) parallaxes left under a pushed page.
  const hubShift = useHubShift(hubCovered)
  // Manage orders / money shifts left too when a screen opens over it.
  const subCovered = !isDesktop && !!screen
  // Phone / browser Back from Manage orders / money returns to the overview.
  const closeSub = () => { setPayFilter('all'); setTab('overview') }
  useBackLayer(subOpen, closeSub)
  // The hub shows the bottom nav, so its body clears it (65px + safe area).
  // A sub-view covers the nav (like every other detail page), so its body
  // only needs the safe area.
  // Collect payment / Shop QR: the store chip in their title row.
  const screenStorePick = stores.length > 1 && activeStore
    ? { stores: storePickList, value: activeStore.id, onChange: pickStore, onManage: open('team') } : undefined
  const bodyPad = { paddingBottom: isDesktop ? 24 : 'calc(env(safe-area-inset-bottom, 0px) + 96px)' }
  const panelPad = { paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)' }
  const seeAllPayments = () => { setPayFilter('all'); setPayView('payments'); setTab('payments') }
  // Desktop: the shared 65/35 layout (DesktopTwoColumn) like P2P, Swap and
  // Multichain - the hub and every Business page in the main column (a stage
  // its screens push over), Verified payments on the right. One tree for
  // both, so resizing across the breakpoint keeps all state.
  return (
    <DesktopTwoColumn isDesktop={isDesktop} stage className="bg-bg"
      phoneClassName="relative flex flex-col h-full min-h-0 bg-bg overflow-hidden"
      main={<>
      {/* ── Overview hub: always mounted; parallaxes left under a sub-view ── */}
      <div className="flex-1 min-h-0 flex flex-col" style={hubShift}>
        {/* The business, then (several stores) the one store everything below
            is for, with Switch - never every store mixed together. */}
        <BusinessHeader desktop={isDesktop} storeName={storeName} handle={handle}
          status={headerStatus} voiceOn={voice.enabled}
          onVoice={() => setVoiceOpen(true)} onMenu={open(locked ? 'profile' : 'tools')}
          avatarName={storeName} avatarUrl={userAvatar ?? undefined} />
        {stores.length > 1 && activeStore && (
          <div className="px-5 pb-2">
            <StorePicker stores={storePickList} value={activeStore.id} onChange={pickStore} onManage={open('team')}
              label="Showing store" hint="Sales, payments, requests and the QR show this store only" />
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-y-auto" style={bodyPad}>
          {locked && <LockedHubView banner={banner} terms={terms} />}
          {!locked && (
            <HubView terms={terms} loading={!loaded} banner={banner} periodLabel={period.label} onPeriod={() => setPeriodSheet(true)}
              sales={{ total: money(today.total), trend: <TrendChip pct={trend} compare={period.compareLabel} /> }}
              pending={pending ? { count: pending.count, due: money(pending.due) } : null}
              available={stores.length > 1 ? money(today.onArc) : money(arcBalance)} availableLabel={stores.length > 1 ? 'On Arc' : undefined} onPending={openOrders} onAvailable={() => setTab('settlements')}
              collect={{ badge: stores.length > 1 ? `${activeStore?.name} QR` : 'Show your QR', tone: 'brand', onClick: open('receive') }}
              orders={{ badge: !pending ? 'Loading…' : pending.count ? `${pending.count} open` : `No open ${terms.orders.toLowerCase()}`, tone: pending?.count ? 'warning' : 'neutral', onClick: openOrders }}
              money={{ badge: settle.total > 0 ? `${money(settle.total)} to settle` : scanning ? 'Checking chains…' : 'All on Arc', tone: settle.total > 0 ? 'brand' : 'neutral', onClick: () => setTab('settlements') }}
              tools={{ badge: stores.length ? `${stores.length} store${stores.length === 1 ? '' : 's'}` : isMerchant ? 'Add a store' : 'Profile & help', onClick: open('tools') }}
              recent={payments.slice(0, 4)} onSeeAll={seeAllPayments} onPayment={setDetail} hideRecent={isDesktop} />
          )}
        </div>
      </div>

      {/* ── Manage orders / Manage money: a full page that slides in from the
          right over a dim veil with the edge shadow - the same page push the
          rest of the app uses. Like every other detail page (Pay, Receive) and
          the Business screens, it covers the bottom nav (fixed, z-40). ── */}
      <PushLayer open={subOpen} covered={subCovered} zIndex={40}>
             <div className={`relative w-full flex flex-col h-full ${isDesktop ? '' : 'max-w-md'}`}>
              {/* Payments and Settlements open from Overview (See all, the settle
                  bar, the menu) and come back with the arrow - no tab bar. */}
              <header className={`header-row gap-3 px-5 ${isDesktop ? 'pt-0' : 'pt-header'} pb-header`}>
                <button type="button" aria-label="Back to overview" onClick={closeSub} className="back-btn">
                  <ArrowLeft className="w-5 h-5 text-text-primary" />
                </button>
                <h1 className="header-title">{tab === 'payments' ? `Manage ${terms.orders.toLowerCase()}` : 'Manage money'}</h1>
                {tab === 'payments' && stores.length > 1 && <span className="ml-auto mr-2 text-xs text-text-muted truncate">{activeStore?.name}</span>}
              </header>
              {tab === 'payments' && <div className="px-5 pt-2">
                <div className="flex p-1 rounded-2xl bg-surface border border-border" role="tablist" aria-label="Orders or payments">
                  {([['requests', terms.orders], ['payments', 'Payments']] as const).map(([id, label]) => (
                    <button key={id} type="button" role="tab" aria-selected={payView === id} onClick={() => setPayView(id)}
                      className={`flex-1 min-h-[40px] rounded-xl text-sm font-semibold transition-colors ${payView === id ? 'bg-card text-text-primary shadow-sm' : 'text-text-muted'}`}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>}
              <div className="flex-1 min-h-0 overflow-y-auto" style={panelPad}>
                {tab === 'payments' && payView === 'requests' && <RequestsList active storeId={activeStore?.id ?? null} mainStoreId={mainStoreId}
                  storeName={storeName} storeNameOf={i => stores.find(st => st.id === (i.storeId ?? mainStoreId))?.name ?? null} paymentsOf={i => paymentsByIntent.get(i.id) ?? []} refundedOf={p => refundedOf(p.id)} onRefund={refundFromOrder} />}
                {tab === 'payments' && payView === 'payments' && <PaymentsView key={payFilter} initialFilter={payFilter}
                  loading={!loaded} payments={payList} onPayment={setDetail} />}
                {tab === 'settlements' && <div className="mx-5 mt-2 mb-1"><ArcBalanceCard amount={money(arcBalance)} note="Ready to spend, refund or cash out"
                  action={<span className="flex gap-2 shrink-0">
                    <button type="button" onClick={open('payouts')} className="min-h-[40px] px-3.5 rounded-xl border border-border bg-card text-text-primary text-[13px] font-semibold active:bg-border/30">Pay staff</button>
                    <button type="button" onClick={open('cashout')} className="min-h-[40px] px-3.5 rounded-xl bg-brand text-white text-[13px] font-semibold active:opacity-90">Cash out</button>
                  </span>} /></div>}
                {tab === 'settlements' && (
                  <SettlementsView scanning={scanning}
                    chains={(settle.allChains ?? []).map(c => ({ id: c.id, label: c.label, logo: c.logo, balance: money(c.balance),
                      onSettle: () => beginSettleOne(c.id), settleDisabled: settle.running || c.balance < settle.singleMin }))}
                    total={money(settle.total)}
                    settle={{ enabled: !scanning && settle.ready && !settle.running && settle.due.length > 0, label: settleLabel, note: settleNote }}
                    onSettle={() => beginSettle()} onRefresh={settle.rescan}
                    history={historyItems} onHistory={id => { setProgressOpen(false); setHistoryId(id) }}
                    lastRun={settle.run.length ? { running: settle.running, onOpen: () => { setHistoryId(null); setProgressOpen(true) } } : undefined} />
                )}
                {tab === 'settlements' && (
                  <div className="mx-5 mt-5">
                    <AutoSettleCard schedule={autoSettle.settings.schedule} time={autoSettle.settings.time}
                      onSchedule={s => autoSettle.update({ schedule: s })} onTime={t => autoSettle.update({ time: t, lastPrompt: Date.now() })} nextLabel={autoSettle.nextLabel} />
                  </div>
                )}
              </div>
             </div>
      </PushLayer>

      <PaymentDetailSheet payment={detail} explorerUrl={rawDetail ? explorerTxUrl(rawDetail.chain, rawDetail.txHash) ?? undefined : undefined}
        onClose={() => setDetail(null)} onSettle={() => { setDetail(null); setTab('settlements') }}
        onReceipt={() => { if (rawDetail) { setReceiptFor(rawDetail); setDetail(null); child('receipt') } }}
        onRefund={rawDetail && detailCanRefund && sender?.id === rawDetail.id && sender.check?.refundable ? () => { openRefund(rawDetail); setDetail(null) } : undefined}
        refundNote={sender?.id === detail?.id ? (sender?.check ? sender.check.reason : 'Checking who sent this payment…') : undefined}
        wallet={rawDetail && !rawDetail.customerUsername && rawDetail.method !== 'own_transfer' ? rawDetail.from : undefined}
        onCopyWallet={rawDetail ? () => { void copyToClipboard(rawDetail.from).then(ok => toast(ok ? 'Address copied' : 'Could not copy', ok ? 'success' : 'error')) } : undefined}
        customer={detailCustomer} store={rawDetail && stores.length ? stores.find(st => st.id === storeOf(rawDetail))?.name : undefined}
        onChat={rawDetail?.customerUsername ? () => { const u = rawDetail.customerUsername!; setDetail(null); void openChat(u) } : undefined}
        refunds={detailRefunds.map(r => ({ id: r.id, amount: money(r.amount), reason: r.reason, when: r.createdAt, chainLabel: chainLabel(r.chain),
          txUrl: explorerTxUrl(r.route === 'chain' ? r.chain : 'Arc_Testnet', r.txHash) ?? undefined }))}
        refundTotals={rawDetail && detailRefunds.length ? { refunded: money(refundedOf(rawDetail.id)), left: money(kept(rawDetail)) } : undefined} />

      <RefundSheet open={!!refundFor} amount={refundShown ? money(refundShownLeft) : ''} customer={refundShown ? who(refundShown) : ''}
        already={refundShown && refundedOf(refundShown.id) > 0 ? `${money(refundedOf(refundShown.id))} of ${money(refundShown.amount)} already refunded` : undefined}
        reasons={REFUND_REASONS} reason={refundReason} onReason={setRefundReason} note={refundNote} onNote={setRefundNote}
        value={refundAmount} onValue={setRefundAmount} max={refundShown ? refundShownLeft : undefined}
        busy={refundBusy} error={refundError} onConfirm={confirmRefund} onClose={() => { if (!refundBusy) setRefundFor(null) }}
        destinations={refundShown && refundShown.chain !== 'Arc_Testnet' ? [
          { id: 'chain', label: `From ${chainLabel(refundShown.chain)}`,
            hint: chainLeft === null ? `Checking your ${chainLabel(refundShown.chain)} balance…` : chainLeft >= (Number(refundAmount) || refundShownLeft)
              ? `Your ${money(chainLeft)} there · back to their wallet` : `Only ${money(chainLeft)} left there (settled)` },
          ...(canRefundOnChain(refundShown.chain) ? [{ id: 'origin', label: 'From Arc',
            hint: `Your Arc balance · arrives on ${chainLabel(refundShown.chain)}` }] : []),
        ] : undefined}
        destination={refundDest}
        onDestination={id => { if (id === 'chain' && refundShown && chainLeft !== null && chainLeft < (Number(refundAmount) || refundShownLeft)) return; setRefundDest(id as RefundRoute) }}
        blocked={refundBlocked}
        note2={refundShown && refundDest === 'chain' ? `Sent from your USDC on ${chainLabel(refundShown.chain)} - MeshPort pays the gas.`
          : refundShown && refundDest === 'origin' ? `Sent from Arc to their wallet on ${chainLabel(refundShown.chain)} by CCTP - Circle's small fee is added on top.` : undefined} />

      <SettleProgressSheet open={progressOpen || !!historyClaim} running={progressOpen && settle.running} rows={progressRows}
        onClose={() => { setProgressOpen(false); setHistoryId(null) }}
        onRetryFailed={() => { if (failedIds.length) beginSettle(failedIds) }}
        onTrack={id => { const c = settle.run.find(r => r.id === id)?.claimId; if (c) { setProgressOpen(false); setHistoryId(c) } }} />

      <PinSheet open={!!pin} title={pinShown?.kind === 'refund' ? 'Confirm refund' : 'Confirm settle'}
        subtitle={pinShown?.kind === 'refund' ? `Send ${money(Number(refundAmount) || 0)} back to ${refundShown ? who(refundShown) : 'the customer'}`
          : pinShown?.kind === 'one' ? `Move ${money((chains ?? []).find(c => c.id === pinShown.chainId)?.balance ?? 0)} from ${chainLabel(pinShown.chainId)} to Arc`
          : `Move ${money(pinShown?.kind === 'settle' && pinShown.retry ? settle.run.filter(r => pinShown.retry!.includes(r.id)).reduce((s, r) => s + r.balance, 0) : settle.total)} to your Arc balance`}
        bioVerb={pinShown?.kind === 'refund' ? 'Refund' : 'Settle'}
        value={pinValue} onChange={v => { setPinValue(v); setPinError(undefined) }}
        error={pinError} onComplete={code => { void onPin(code) }} onClose={() => setPin(null)} />

      <VoiceSheet open={voiceOpen} enabled={voice.enabled}
        onToggle={() => setVoiceAlerts({ enabled: !voice.enabled })}
        onTest={() => speakPayment(24, { test: true })} onClose={() => setVoiceOpen(false)} />

      {level('tools', (
        <ToolsScreen open={stack.includes('tools')} onBack={back}
          onOpen={(id: ToolId) => { if (id === 'voice') { setVoiceOpen(true); return } child(id) }}
          groups={[
            { title: 'Business', rows: [
              { id: 'team', label: `${terms.stores} & staff`, hint: stores.length ? `${stores.length} store${stores.length === 1 ? '' : 's'} · cashiers and managers` : 'Add outlets, invite cashiers' },
              { id: 'customers', label: terms.customers, hint: pendingCredit > 0 ? `${money(pendingCredit)} outstanding · history and reminders` : 'Everyone who paid, with their history' },
              { id: 'reports', label: 'Reports', hint: 'Insights and statement · CSV and PDF' },
              { id: 'activity', label: 'Activity log', hint: `Who billed, refunded, settled · you and staff` },
            ] },
            { title: 'Money', rows: [
              { id: 'payouts', label: 'Pay staff', hint: 'Salary and suppliers · everyone in one payment' },
              { id: 'cashout', label: 'Cash out', hint: 'Dollars to your UPI or bank in rupees' },
            ] },
            { title: 'Settings', rows: [
              { id: 'profile', label: 'Business profile', hint: `${headerStatus === 'verified' ? 'Verified' : 'Complete your application'} · name, logo, payment limits` },
              { id: 'voice', label: 'Voice alerts', hint: voice.enabled ? 'On · speaks each payment' : 'Off' },
              { id: 'help', label: 'Help & disputes', hint: 'Customer says they paid' },
            ] },
          ]} />
      ))}


      <DateRangeSheet open={!!rangeSheet} from={rangeShown?.from ?? ''} to={rangeShown?.to ?? ''}
        onFrom={v => setRangeSheet(r => r && { ...r, from: v })} onTo={v => setRangeSheet(r => r && { ...r, to: v })}
        presets={[{ id: '30', label: 'Last 30 days' }, { id: 'lastmonth', label: 'Last month' }, { id: 'year', label: 'This year' }]}
        onPreset={id => {
          const d = new Date(), iso = (x: Date) => x.toLocaleDateString('en-CA')
          const r = id === '30' ? { from: iso(new Date(Date.now() - 29 * 86_400_000)), to: iso(d) }
            : id === 'lastmonth' ? { from: iso(new Date(d.getFullYear(), d.getMonth() - 1, 1)), to: iso(new Date(d.getFullYear(), d.getMonth(), 0)) }
            : { from: iso(new Date(d.getFullYear(), 0, 1)), to: iso(d) }
          setRangeSheet(r)
        }}
        onApply={() => {
          if (rangeSheet?.from && rangeSheet.to) choosePeriod({ id: 'custom', ...rangeSheet })
          setRangeSheet(null)
        }}
        onClose={() => setRangeSheet(null)} />

      <PeriodSheet open={periodSheet} value={periodSel.id} customLabel={period.id === 'custom' ? period.label : undefined}
        onPick={id => { choosePeriod({ ...periodSel, id }); setPeriodSheet(false) }}
        onCustom={() => { setPeriodSheet(false); setRangeSheet({ from: periodSel.from, to: periodSel.to }) }}
        onClose={() => setPeriodSheet(false)} />

      <SettleDueSheet open={!locked && autoSettle.due && settle.ready && settle.due.length > 0 && !settle.running} amount={money(settle.total)}
        chains={settle.due.map(c => ({ label: c.label, logo: c.logo }))}
        onSettle={() => { autoSettle.dismiss(); setTab('settlements'); beginSettle() }} onLater={autoSettle.dismiss} />

      <RequestMaker.Provider value={{ create: createPaymentRequest, storeId: qrStore?.id ?? null, canBill: true, chat: true }}>
      {level('qr', (
        <ShopQrScreen open={stack.includes('qr')} onBack={back} storeName={storeName} outlet={stores.length > 1 ? qrStore?.name : null} handle={handle} storePick={screenStorePick} avatar={userAvatar} />
      ))}
      {level('receive', (
        <ReceiveScreen open={stack.includes('receive')} onBack={() => { back(); reloadIntents() }} onChanged={reloadIntents} storeName={storeName}
          shopQr={{ handle, outlet: stores.length > 1 ? qrStore?.name : null }} storePick={screenStorePick} avatar={userAvatar} />
      ))}
      {level('customers', (
        <CustomersScreen open={stack.includes('customers')} onBack={back} payments={storeRaw.filter(p => p.method !== 'own_transfer').map(p => refundedOf(p.id) > 0 && !refundedIds.has(p.id) ? { ...p, amount: kept(p) } : p)} refundedIds={refundedIds}
          onPayment={p => setDetail(toRow(p))} onChat={u => { close(); void openChat(u) }}
          orders={(intents ?? []).filter(i => !activeStore || inStore(i, activeStore.id))} onOrdersChanged={reloadIntents} />
      ))}
      {level('reports', (
        <ReportsScreen open={stack.includes('reports')} onBack={back}
          insights={{ payments: netOf(storeRaw), waiting: money(settle.total), period, scope: stores.length > 1 ? activeStore?.name : null, compare: storeCompare }}
          storePick={stores.length > 1 && activeStore ? { stores: storePickList, value: activeStore.id, onChange: pickStore, onManage: open('team') } : undefined}
          statement={{ storeName: stores.length > 1 && activeStore ? `${storeName} · ${activeStore.name}` : storeName, handle,
            payments: storeRaw.filter(p => p.method !== 'own_transfer'), refunds: activeStore ? refunds.filter(r => storeRaw.some(p => p.id === r.paymentId)) : refunds,
            settled: (history ?? []).filter(c => c.status === 'completed').map(c => ({ amount: c.arrivedAmount ?? c.amount, createdAt: c.createdAt })),
            waiting: (chains ?? []).reduce((s, c) => s + c.balance, 0), loading: !loaded }} />
      ))}
      {level('receipt', (
        <ReceiptScreen open={stack.includes('receipt')} onBack={back} storeName={storeName} handle={handle} payment={receiptFor} refunded={!!(receiptFor && refundedIds.has(receiptFor.id))} />
      ))}
      {level('help', (
        <HelpScreen open={stack.includes('help')} onBack={back} />
      ))}
      {level('profile', (
        <ProfileScreen open={stack.includes('profile')} onBack={back} handle={handle} />
      ))}
      </RequestMaker.Provider>
      {level('cashout', (
        <CashOutScreen open={stack.includes('cashout')} onBack={back} />
      ))}
      {level('payouts', (
        <PayoutsScreen open={stack.includes('payouts')} onBack={back} />
      ))}
      {level('activity', (
        <ActivityScreen open={stack.includes('activity')} onBack={back} />
      ))}
      {level('team', (
        <TeamScreen open={stack.includes('team')} onBack={back} canAddStores={isMerchant} stores={stores} onChanged={setStores} paymentsByStore={paymentsByStore}
          onQr={id => { pickStore(id); child('qr') }} />
      ))}
      </>}
      side={
        <DesktopHistoryPanel title="Verified payments" onViewAll={locked ? undefined : seeAllPayments}>
          {!loaded ? <DesktopHistorySkeleton />
            : payments.length === 0 ? <DesktopHistoryEmpty label={locked ? 'Payments show up here once MeshPort approves your business' : 'No payments yet - open Collect payment to show your QR'} />
            : <div className="divide-y divide-border">{payments.slice(0, 30).map(p => <PaymentRow key={p.id} payment={p} onClick={setDetail} />)}</div>}
        </DesktopHistoryPanel>
      } />
  )
}
