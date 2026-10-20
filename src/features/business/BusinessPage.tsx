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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { useLocation, useNavigate } from 'react-router-dom'
import { pushLook } from '@/lib/pushLook'
import { DESKTOP_QUERY, DESKTOP_FADE_TRANSITION, PAGE_SLIDE_X, PAGE_TRANSITION } from '@/lib/motion'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useBizTerms } from '@/lib/businessCategories'
import { getUserByUsername, getOrCreateConversation } from '@/lib/supabase'
import { ArrowLeft } from 'lucide-react'
import { copyToClipboard } from '@/lib/utils'
import { fetchActivity } from '@/lib/ActivityService'
import { useAuthStore, useWalletStore } from '@/store'
import { useMerchant, useBusinessTab } from '@/lib/merchant'
import { explorerTxUrl } from '@/lib/chainExplorers'
import { chainLogoSrc } from '@/lib/chainLogos'
import { listMyPayments, listMyIntents, listChainReceipts, isOwnReceipt, subscribeMerchantPayments, createPaymentRequest, displayOrderNumber, type MerchantPayment, type MerchantIntent } from '@/lib/merchantPay'
import { listStores, activeStoreId, setActiveStoreId, type Store } from '@/lib/businessTeam'
import { useVoiceAlerts, setVoiceAlerts, speakPayment, VOICE_LANGS, type VoiceLang } from '@/lib/voiceAlerts'
import { useSettlement, useSettlementHistory, chainLabel, claimStage, unlockKey } from './settlement'
import { listMyRefunds, subscribeMyRefunds, refundPayment, chainUsdcBalance, canRefundOnChain, checkRefundableSender, type SenderCheck, REFUND_REASONS, type MerchantRefund, type RefundRoute } from '@/lib/merchantRefunds'
import { groupRefunds, refundedSum, remainingAfter, isFullyRefunded, canRefundMore, netPayments, MIN_REFUND } from '@/lib/refundTotals'
import { makePeriod, inPeriod, inPrevious, periodTrend, savedPeriod, savePeriod, type PeriodId } from './period'
import { useAutoSettle } from './autoSettle'
import { CashOutScreen, TeamScreen } from './teamScreens'
import { PayoutsScreen } from './payoutsScreen'
import { ToolsScreen, type ToolId } from './toolsScreen'
import { StaffModePage } from './staffMode'
import { ActivityScreen } from './activityScreen'
import { logBusiness } from '@/lib/businessActivity'
import { readArcBalanceOrThrow } from '@/blockchain/BlockchainManager'
import { refreshBalancesAfterTx } from '@/lib/balanceRefresh'
import { useUIStore } from '@/store'
import { RequestMaker, ShopQrScreen, ReceiveScreen, RequestsList, CustomersScreen, ReportsScreen, ProfileScreen, ReceiptScreen, HelpScreen } from './screens'
import {
  BusinessHeader, SetupBanner, HubView, LockedHubView, PaymentsView, PaymentDetailSheet,
  SettlementsView, SettleProgressSheet, PasscodeSheet, VoiceSheet, RefundSheet, TrendChip,
  DateRangeSheet, PeriodSheet, ArcBalanceCard, AutoSettleCard, SettleDueSheet, StoreSwitcher, Sheet, ScreenLevel, PUSH_BACK,
  type BusinessTab, type Payment, type VerificationStatus, type SettleProgressRow,
} from './ui'

type ScreenId = 'qr' | 'receive' | 'customers' | 'reports' | 'profile' | 'receipt' | 'help' | 'cashout' | 'team' | 'payouts' | 'tools' | 'activity'

// Back is the app's back push: 250ms on the same ease-out (BusinessScreen).
const PANEL_EXIT = { x: '100%', transition: PUSH_BACK }
const EASE_CSS = 'cubic-bezier(0.32, 0.72, 0, 1)'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const who = (p: MerchantPayment) => p.method === 'own_transfer' ? 'Your transfer'
  : p.customerUsername ? `${p.customerUsername}.arc` : `${p.from.slice(0, 6)}…${p.from.slice(-4)}`
const inWords = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

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
  const [raw, setRaw] = useState<MerchantPayment[]>([])
  const [loaded, setLoaded] = useState(false)
  // Every USDC that reached the business: order payments; USDC on other
  // chains (merchant_chain_receipts, own transfers marked 'own_transfer');
  // and direct receives on Arc from anyone - people, contracts, exchanges
  // (the wallet's Activity 'receive' rows) that aren't order payments.
  const load = useCallback(async () => {
    const [orders, receipts, activity] = await Promise.all([
      listMyPayments(500), listChainReceipts(300).catch(() => []),
      walletAddress ? fetchActivity(walletAddress, { limit: 300 }).catch(() => []) : Promise.resolve([]),
    ])
    const known = new Set(orders.map(p => `${p.chain}:${p.txHash.toLowerCase()}`))
    const extra: MerchantPayment[] = receipts
      .filter(r => !known.has(`${r.chain}:${r.txHash.toLowerCase()}`))
      .map(r => ({ id: `rcpt_${r.id}`, intentId: '', chain: r.chain, txHash: r.txHash, from: r.from ?? '0x0000000000000000000000000000000000000000',
        amount: r.amount, method: isOwnReceipt(r, walletAddress) ? 'own_transfer' : 'chain_receipt',
        status: r.status === 'converted' ? 'collected' : 'in_ledger', customerUsername: null,
        createdAt: r.createdAt, orderNumber: r.orderNumber, matchedBy: null, screenFlag: r.screenFlag ?? null }))
    const direct: MerchantPayment[] = activity
      .filter(a => a.activityType === 'receive' && a.status === 'completed' && (a.tokenSymbol || 'USDC').toUpperCase() === 'USDC'
        && a.txHash && !known.has(`Arc_Testnet:${a.txHash.toLowerCase()}`))
      .map(a => ({ id: `act_${a.id}`, intentId: '', chain: 'Arc_Testnet', txHash: a.txHash!, from: a.counterpartyAddress ?? '0x0000000000000000000000000000000000000000',
        amount: a.amount, method: 'direct', status: 'confirmed', createdAt: a.createdAt, orderNumber: null, matchedBy: null,
        customerUsername: String((a.metadata as any)?.fromUsername ?? '').replace(/\.arc$/i, '') || null }))
    setRaw([...orders, ...extra, ...direct].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))); setLoaded(true)
  }, [walletAddress])
  useEffect(() => { void load() }, [load])
  useEffect(() => (walletAddress ? subscribeMerchantPayments(walletAddress, () => { void load() }) : undefined), [walletAddress, load])
  // Payments on other chains have no live feed - refresh while the tab is open.
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 30_000)
    return () => clearInterval(t)
  }, [load])
  const [refunds, setRefunds] = useState<MerchantRefund[]>([])
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

  // ── Stores (which store this device works as; null = all) ─────────────
  const [stores, setStores] = useState<Store[]>([])
  const [storeId, setStoreId] = useState<string | null>(activeStoreId)
  const [intents, setIntents] = useState<MerchantIntent[] | null>(null)
  const intentStore = useMemo(() => new Map((intents ?? []).map(i => [i.id, i.storeId ?? null] as const)), [intents])
  // Other-chain receipts carry the order number, not the order id.
  const orderStore = useMemo(() => new Map((intents ?? []).filter(i => i.orderNumber).map(i => [i.orderNumber!, i.storeId ?? null] as const)), [intents])
  const [switcher, setSwitcher] = useState(false)
  const [periodSheet, setPeriodSheet] = useState(false)
  const [payView, setPayView] = useState<'payments' | 'requests'>('payments')
  useEffect(() => { if (tab !== 'payments') setPayView('payments') }, [tab])
  const [payFilter, setPayFilter] = useState<'all' | 'refunded'>('all')
  useEffect(() => { listStores().then(setStores).catch(() => {}) }, [])
  const reloadIntents = useCallback(() => { listMyIntents(500).then(setIntents).catch(() => setIntents(l => l ?? [])) }, [])
  useEffect(reloadIntents, [raw.length, tab, reloadIntents])
  const activeStore = stores.find(s => s.id === storeId) ?? null
  // Requests and the Shop QR belong to the picked store; with "All stores"
  // they go to the main (default) store.
  const qrStore = activeStore ?? stores.find(s => s.isDefault) ?? null
  const pickStore = (id: string | null) => { setStoreId(id); setActiveStoreId(id); setSwitcher(false) }
  // A payment's store is its order's store; anything without one (taken
  // before stores, other-chain receipts, plain transfers) is the main store's.
  const mainStoreId = stores.find(s => s.isDefault)?.id ?? null
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
  const choosePeriod = (v: { id: PeriodId; from: string; to: string }) => { setPeriodSel(v); savePeriod(v) }
  const period = useMemo(() => makePeriod(periodSel.id, periodSel), [periodSel])
  const periodRaw = useMemo(() => storeRaw.filter(p => inPeriod(p.createdAt, period)), [storeRaw, period])

  // ── Settlements ───────────────────────────────────────────────────────
  const settle = useSettlement()
  const { chains } = settle
  const history = useSettlementHistory()
  const waitingOn = new Set((chains ?? []).map(c => c.id))

  // A payment on another chain is "to settle" while that chain still holds USDC.
  const toRow = (p: MerchantPayment): Payment => ({
    id: p.id, from: who(p), amount: money(p.amount), chainLabel: chainLabel(p.chain), chainLogo: chainLogoSrc(p.chain),
    time: p.createdAt, order: p.orderNumber ? displayOrderNumber(p.orderNumber) : undefined, late: !!p.late, blocked: !!p.screenFlag,
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
  const [pinError, setPinError] = useState<string | undefined>()

  // Open screens, bottom to top: a screen opened from another one (Business
  // tools → Stores & staff, Stores → a store's QR, a payment → its receipt)
  // pushes over it, and back uncovers the one beneath - like pages.
  const [stack, setStack] = useState<ScreenId[]>(() => query.get('apply') ? ['profile'] : [])
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
  const allStores = `All ${terms.stores.toLowerCase()}`
  useEffect(() => {
    if (!locked) return
    if (tab !== 'overview') setTab('overview')
    if (stack.some(id => id !== 'profile' && id !== 'help')) setStack([])
  }, [locked, tab, stack])
  const open = (id: ScreenId) => () => setStack([id])
  const close = () => setStack([])
  const back = () => setStack(s => s.slice(0, -1))
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
    if (settle.needsPasscode) { setPinError(undefined); setPin({ kind: 'settle', retry }); return }
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
    if (!await settle.checkPasscode(code)) { setPinError('Incorrect passcode. Try again.'); return }
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
    if (settle.needsPasscode) { setPinError(undefined); setPin({ kind: 'one', chainId }); return }
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
  const confirmRefund = () => {
    if (settle.needsPasscode) { setPinError(undefined); setPin({ kind: 'refund' }); return }
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
  const settleNote = `Uses CCTP. MeshPort pays the gas.${settle.waitHours ? ` Settle all once every ${settle.waitHours} hour${settle.waitHours === 1 ? '' : 's'}; settle one chain any time below.` : ' You can also settle one chain at a time below.'}`

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
    const live = intents.filter(i => (i.status === 'pending' || i.status === 'partially_paid')
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
  const look = useMemo(() => (typeof window === 'undefined' ? { dim: 0.22, shadow: '-10px 0 28px rgba(0,0,0,0.28)' } : pushLook()), [])
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  const reduce = useReducedMotion()
  // Desktop: screens fade in the content area (no sliding), nothing shifts.
  const hubCovered = !isDesktop && (!!screen || subOpen)
  // Opening shifts on the 300ms push, coming back on the 250ms back push.
  const shiftCss = (on: boolean) => `transform ${reduce ? 0 : on ? 0.3 : 0.25}s ${EASE_CSS}`
  const hubShift = { transform: hubCovered ? `translateX(-${PAGE_SLIDE_X})` : undefined, transition: shiftCss(hubCovered), willChange: 'transform' }
  // The bottom tab bar belongs to the hub: like a page push from a tab, it
  // shifts left with it under the dim (PageTransition moves it the same way).
  useLayoutEffect(() => {
    const nav = document.querySelector<HTMLElement>('[data-bottom-nav]')
    if (!nav) return
    nav.style.transition = shiftCss(hubCovered)
    nav.style.transform = hubCovered ? `translateX(-${PAGE_SLIDE_X})` : ''
  }, [hubCovered]) // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => () => {
    const nav = document.querySelector<HTMLElement>('[data-bottom-nav]')
    if (nav) { nav.style.transform = ''; nav.style.transition = '' }
  }, [])
  // Manage orders / money shifts left too when a screen opens over it.
  const subCovered = !isDesktop && !!screen
  // The hub shows the bottom nav, so its body clears it (65px + safe area).
  // A sub-view covers the nav (like every other detail page), so its body
  // only needs the safe area.
  const bodyPad = { paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 96px)' }
  const panelPad = { paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)' }
  return (
    <div className="relative flex flex-col h-full min-h-0 bg-bg overflow-hidden">
      {/* ── Overview hub: always mounted; parallaxes left under a sub-view ── */}
      <div className="flex-1 min-h-0 flex flex-col" style={hubShift}>
        {/* Title = the store being viewed ("All stores" for the totals);
            the line under it is the business account itself. */}
        <BusinessHeader storeName={activeStore?.name ?? (stores.length > 1 ? allStores : storeName)} handle={handle}
          status={headerStatus} voiceOn={voice.enabled}
          onVoice={() => setVoiceOpen(true)} onMenu={open(locked ? 'profile' : 'tools')} onSwitchStore={stores.length ? () => setSwitcher(true) : undefined}
          avatarName={storeName} avatarUrl={userAvatar ?? undefined}
          outlet={(activeStore || stores.length > 1) && activeStore?.name !== storeName ? storeName : null} />
        <div className="flex-1 min-h-0 overflow-y-auto" style={bodyPad}>
          {locked && <LockedHubView banner={banner} terms={terms} />}
          {!locked && (
            <HubView terms={terms} loading={!loaded} banner={banner} periodLabel={period.label} onPeriod={() => setPeriodSheet(true)}
              sales={{ total: money(today.total), trend: <TrendChip pct={trend} compare={period.compareLabel} /> }}
              pending={pending ? { count: pending.count, due: money(pending.due) } : null}
              available={money(arcBalance)} onPending={openOrders} onAvailable={() => setTab('settlements')}
              collect={{ badge: stores.length > 1 ? `${activeStore?.name ?? 'Main store'} QR` : 'Show your QR', tone: 'brand', onClick: open('receive') }}
              orders={{ badge: !pending ? 'Loading…' : pending.count ? `${pending.count} open` : `No open ${terms.orders.toLowerCase()}`, tone: pending?.count ? 'warning' : 'neutral', onClick: openOrders }}
              money={{ badge: settle.total > 0 ? `${money(settle.total)} to settle` : scanning ? 'Checking chains…' : 'All on Arc', tone: settle.total > 0 ? 'brand' : 'neutral', onClick: () => setTab('settlements') }}
              tools={{ badge: stores.length ? `${stores.length} store${stores.length === 1 ? '' : 's'}` : isMerchant ? 'Add a store' : 'Profile & help', onClick: open('tools') }}
              recent={payments.slice(0, 4)} onSeeAll={() => { setPayFilter('all'); setPayView('payments'); setTab('payments') }} onPayment={setDetail} />
          )}
        </div>
      </div>

      {/* ── Manage orders / Manage money: a full page that slides in from the
          right over a dim veil with the edge shadow - the same page push the
          rest of the app uses. Like every other detail page (Pay, Receive) and
          the Business screens, it covers the bottom nav (fixed, z-40). ── */}
      <AnimatePresence>
        {subOpen && (
          <>
            {!isDesktop && <motion.div className="fixed inset-0 z-40 pointer-events-none" aria-hidden
              style={{ background: '#000' }} initial={{ opacity: 0 }} animate={{ opacity: look.dim }}
              exit={{ opacity: 0, transition: PUSH_BACK }} transition={reduce ? { duration: 0 } : PAGE_TRANSITION} />}
            <motion.div className={`${isDesktop ? 'absolute' : 'fixed'} inset-0 z-40 flex justify-center bg-bg`} style={{ boxShadow: isDesktop ? undefined : look.shadow }}
              initial={isDesktop ? { opacity: 0, y: 4 } : { x: '100%' }}
              animate={isDesktop ? { opacity: 1, y: 0 } : { x: subCovered ? `-${PAGE_SLIDE_X}` : 0, transition: subCovered ? PAGE_TRANSITION : PUSH_BACK }}
              exit={isDesktop ? { opacity: 0, transition: { duration: 0.12 } } : PANEL_EXIT}
              transition={reduce ? { duration: 0 } : isDesktop ? DESKTOP_FADE_TRANSITION : PAGE_TRANSITION}>
             <div className="relative w-full max-w-md flex flex-col h-full">
              {/* Payments and Settlements open from Overview (See all, the settle
                  bar, the menu) and come back with the arrow - no tab bar. */}
              <header className="header-row gap-3 px-5 pt-header pb-header">
                <button type="button" aria-label="Back to overview" onClick={() => { setPayFilter('all'); setTab('overview') }} className="back-btn">
                  <ArrowLeft className="w-5 h-5 text-text-primary" />
                </button>
                <h1 className="header-title">{tab === 'payments' ? `Manage ${terms.orders.toLowerCase()}` : 'Manage money'}</h1>
                {tab === 'payments' && stores.length > 1 && <span className="ml-auto mr-2 text-xs text-text-muted truncate">{activeStore?.name ?? allStores}</span>}
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
                  storeName={storeName} paymentsOf={i => paymentsByIntent.get(i.id) ?? []} refundedOf={p => refundedOf(p.id)} onRefund={refundFromOrder} />}
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
            </motion.div>
          </>
        )}
      </AnimatePresence>

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

      <RefundSheet open={!!refundFor} amount={refundFor ? money(refundLeft) : ''} customer={refundFor ? who(refundFor) : ''}
        already={refundFor && refundedOf(refundFor.id) > 0 ? `${money(refundedOf(refundFor.id))} of ${money(refundFor.amount)} already refunded` : undefined}
        reasons={REFUND_REASONS} reason={refundReason} onReason={setRefundReason} note={refundNote} onNote={setRefundNote}
        value={refundAmount} onValue={setRefundAmount} max={refundFor ? refundLeft : undefined}
        busy={refundBusy} error={refundError} onConfirm={confirmRefund} onClose={() => { if (!refundBusy) setRefundFor(null) }}
        destinations={refundFor && refundFor.chain !== 'Arc_Testnet' ? [
          { id: 'chain', label: `From ${chainLabel(refundFor.chain)}`,
            hint: chainLeft === null ? `Checking your ${chainLabel(refundFor.chain)} balance…` : chainLeft >= (Number(refundAmount) || refundLeft)
              ? `Your ${money(chainLeft)} there · back to their wallet` : `Only ${money(chainLeft)} left there (settled)` },
          ...(canRefundOnChain(refundFor.chain) ? [{ id: 'origin', label: 'From Arc',
            hint: `Your Arc balance · arrives on ${chainLabel(refundFor.chain)}` }] : []),
        ] : undefined}
        destination={refundDest}
        onDestination={id => { if (id === 'chain' && refundFor && chainLeft !== null && chainLeft < (Number(refundAmount) || refundLeft)) return; setRefundDest(id as RefundRoute) }}
        blocked={refundBlocked}
        note2={refundFor && refundDest === 'chain' ? `Sent from your USDC on ${chainLabel(refundFor.chain)} - MeshPort pays the gas.`
          : refundFor && refundDest === 'origin' ? `Sent from Arc to their wallet on ${chainLabel(refundFor.chain)} by CCTP - Circle's small fee is added on top.` : undefined} />

      <SettleProgressSheet open={progressOpen || !!historyClaim} running={progressOpen && settle.running} rows={progressRows}
        onClose={() => { setProgressOpen(false); setHistoryId(null) }}
        onRetryFailed={() => { if (failedIds.length) beginSettle(failedIds) }}
        onTrack={id => { const c = settle.run.find(r => r.id === id)?.claimId; if (c) { setProgressOpen(false); setHistoryId(c) } }} />

      <PasscodeSheet open={!!pin} title={pin?.kind === 'refund' ? 'Confirm refund' : 'Confirm settle'}
        subtitle={pin?.kind === 'refund' ? `Send ${money(Number(refundAmount) || 0)} back to ${refundFor ? who(refundFor) : 'the customer'}`
          : pin?.kind === 'one' ? `Move ${money((chains ?? []).find(c => c.id === pin.chainId)?.balance ?? 0)} from ${chainLabel(pin.chainId)} to Arc`
          : `Move ${money(pin?.kind === 'settle' && pin.retry ? settle.run.filter(r => pin.retry!.includes(r.id)).reduce((s, r) => s + r.balance, 0) : settle.total)} to your Arc balance`}
        error={pinError} onComplete={code => { void onPin(code) }} onClose={() => setPin(null)} />

      <VoiceSheet open={voiceOpen} enabled={voice.enabled} lang={voice.lang}
        langs={VOICE_LANGS.map(l => ({ id: l.id, label: l.label }))}
        onToggle={() => setVoiceAlerts({ enabled: !voice.enabled })} onLang={id => setVoiceAlerts({ lang: id as VoiceLang })}
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
              { id: 'payouts', label: 'Payouts', hint: 'Pay staff and suppliers · once or on a repeat' },
              { id: 'cashout', label: 'Cash out to bank', hint: 'Sell USDC for INR to UPI or bank' },
            ] },
            { title: 'Settings', rows: [
              { id: 'profile', label: 'Business profile', hint: `${headerStatus === 'verified' ? 'Verified' : 'Complete your application'} · name, logo, payment limits` },
              { id: 'voice', label: 'Voice alerts', hint: voice.enabled ? 'On · speaks each payment' : 'Off' },
              { id: 'help', label: 'Help & disputes', hint: 'Customer says they paid' },
            ] },
          ]} />
      ))}

      <Sheet open={switcher} onClose={() => setSwitcher(false)}>
        <StoreSwitcher stores={[{ id: '', name: allStores, handle: `${stores.length} store${stores.length === 1 ? '' : 's'} together`, active: !activeStore, all: true },
          ...stores.map(s => ({ id: s.id, name: s.name, handle: `${s.isDefault ? 'Main store · ' : ''}${s.type ?? 'Store'}`, active: activeStore?.id === s.id }))]}
          onSwitch={id => pickStore(id || null)} onManage={() => { setSwitcher(false); open('team')() }} />
      </Sheet>

      <DateRangeSheet open={!!rangeSheet} from={rangeSheet?.from ?? ''} to={rangeSheet?.to ?? ''}
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
        <ShopQrScreen open={stack.includes('qr')} onBack={back} storeName={storeName} outlet={stores.length > 1 ? qrStore?.name : null} handle={handle} />
      ))}
      {level('receive', (
        <ReceiveScreen open={stack.includes('receive')} onBack={() => { back(); reloadIntents() }} onChanged={reloadIntents} storeName={storeName}
          shopQr={{ handle, outlet: stores.length > 1 ? qrStore?.name : null }} />
      ))}
      {level('customers', (
        <CustomersScreen open={stack.includes('customers')} onBack={back} payments={storeRaw.filter(p => p.method !== 'own_transfer').map(p => refundedOf(p.id) > 0 && !refundedIds.has(p.id) ? { ...p, amount: kept(p) } : p)} refundedIds={refundedIds}
          onPayment={p => setDetail(toRow(p))} onChat={u => { close(); void openChat(u) }}
          orders={(intents ?? []).filter(i => !activeStore || inStore(i, activeStore.id))} onOrdersChanged={reloadIntents} />
      ))}
      {level('reports', (
        <ReportsScreen open={stack.includes('reports')} onBack={back}
          insights={{ payments: netOf(storeRaw), waiting: money(settle.total), period, scope: stores.length > 1 ? activeStore?.name : null }}
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
    </div>
  )
}
