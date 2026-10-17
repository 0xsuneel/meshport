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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useAuthStore, useWalletStore } from '@/store'
import { useMerchant, useBusinessTab } from '@/lib/merchant'
import { explorerTxUrl } from '@/lib/chainExplorers'
import { chainLogoSrc } from '@/lib/chainLogos'
import { listMyPayments, listMyIntents, listChainReceipts, isOwnReceipt, subscribeMerchantPayments, createPaymentRequest, type MerchantPayment } from '@/lib/merchantPay'
import { listStores, activeStoreId, setActiveStoreId, type Store } from '@/lib/businessTeam'
import { useVoiceAlerts, setVoiceAlerts, speakPayment, VOICE_LANGS, type VoiceLang } from '@/lib/voiceAlerts'
import { useSettlement, useSettlementHistory, chainLabel, claimStage, unlockKey } from './settlement'
import { listMyRefunds, subscribeMyRefunds, refundPayment, chainUsdcBalance, checkRefundableSender, type SenderCheck, REFUND_REASONS, type MerchantRefund, type RefundRoute } from '@/lib/merchantRefunds'
import { makePeriod, inPeriod, inPrevious, periodTrend, savedPeriod, savePeriod, type PeriodId } from './period'
import { useAutoSettle } from './autoSettle'
import { CashOutScreen, TeamScreen } from './teamScreens'
import { StaffModePage } from './staffMode'
import { useUIStore } from '@/store'
import { RequestMaker, ShopQrScreen, ReceiveScreen, RequestsScreen, ReportsScreen, ProfileScreen, ReceiptScreen, HelpScreen } from './screens'
import {
  BusinessHeader, SetupBanner, OverviewView, PaymentsView, PaymentDetailSheet,
  SettlementsView, SettleProgressSheet, PasscodeSheet, VoiceSheet, RefundSheet, TrendChip,
  DateRangeBar, DateRangeSheet, PeriodSheet, ArcBalanceCard, AutoSettleCard, SettleDueSheet, StoreSwitcher, Sheet, BusinessMenuSheet,
  type BusinessTab, type Payment, type VerificationStatus, type SettleProgressRow,
} from './ui'

type ScreenId = 'qr' | 'receive' | 'requests' | 'reports' | 'profile' | 'receipt' | 'help' | 'cashout' | 'team'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const who = (p: MerchantPayment) => p.customerUsername ? `${p.customerUsername}.arc` : `${p.from.slice(0, 6)}…${p.from.slice(-4)}`
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
  const voice = useVoiceAlerts()

  const [tab, setTab] = useState<BusinessTab>(() => {
    if (query.get('claim')) return 'settlements'
    const t = (location.state as { btab?: BusinessTab } | null)?.btab ?? query.get('tab')
    return t === 'payments' || t === 'settlements' ? t : 'overview'
  })

  const toast = useUIStore(s => s.showToastMessage)

  // ── Payments and refunds (live; the pop-up and voice alert for a new
  // payment come from PaymentReceivedWatcher, on every screen) ──────────
  const [raw, setRaw] = useState<MerchantPayment[]>([])
  const [loaded, setLoaded] = useState(false)
  // Order payments, plus USDC that reached the store's address on another
  // chain without an order (merchant_chain_receipts; not its own transfers).
  const load = useCallback(async () => {
    const [orders, receipts] = await Promise.all([listMyPayments(500), listChainReceipts(300).catch(() => [])])
    const known = new Set(orders.map(p => `${p.chain}:${p.txHash.toLowerCase()}`))
    const extra: MerchantPayment[] = receipts
      .filter(r => !isOwnReceipt(r, walletAddress) && !known.has(`${r.chain}:${r.txHash.toLowerCase()}`))
      .map(r => ({ id: `rcpt_${r.id}`, intentId: '', chain: r.chain, txHash: r.txHash, from: r.from ?? '0x0000000000000000000000000000000000000000',
        amount: r.amount, method: 'chain_receipt', status: r.status === 'converted' ? 'collected' : 'in_ledger', customerUsername: null,
        createdAt: r.createdAt, orderNumber: r.orderNumber, matchedBy: null }))
    setRaw([...orders, ...extra].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))); setLoaded(true)
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
  const refundOf = useMemo(() => new Map(refunds.map(r => [r.paymentId, r])), [refunds])

  // ── Stores (which store this device works as; null = all) ─────────────
  const [stores, setStores] = useState<Store[]>([])
  const [storeId, setStoreId] = useState<string | null>(activeStoreId)
  const [intentStore, setIntentStore] = useState<Map<string, string | null>>(new Map())
  const [switcher, setSwitcher] = useState(false)
  const [menu, setMenu] = useState(false)
  const [periodSheet, setPeriodSheet] = useState(false)
  const [payFilter, setPayFilter] = useState<'all' | 'refunded'>('all')
  useEffect(() => { listStores().then(setStores).catch(() => {}) }, [])
  useEffect(() => { listMyIntents(500).then(l => setIntentStore(new Map(l.map(i => [i.id, i.storeId ?? null])))).catch(() => {}) }, [raw.length])
  const activeStore = stores.find(s => s.id === storeId) ?? null
  // Requests and the Shop QR belong to the picked store; with "All stores"
  // they go to the main (default) store.
  const qrStore = activeStore ?? stores.find(s => s.isDefault) ?? null
  const pickStore = (id: string | null) => { setStoreId(id); setActiveStoreId(id); setSwitcher(false) }
  // A payment's store is its order's store; anything without one (taken
  // before stores, other-chain receipts, plain transfers) is the main store's.
  const mainStoreId = stores.find(s => s.isDefault)?.id ?? null
  const storeOf = useCallback((p: MerchantPayment) => intentStore.get(p.intentId) ?? mainStoreId, [intentStore, mainStoreId])
  const storeRaw = useMemo(() => activeStore ? raw.filter(p => storeOf(p) === activeStore.id) : raw, [raw, activeStore, storeOf])
  const paymentsByStore = useMemo(() => {
    const m = new Map<string, { total: number; count: number }>()
    for (const p of raw) { const sid = storeOf(p); if (!sid) continue; const v = m.get(sid) ?? { total: 0, count: 0 }; v.total += p.amount; v.count++; m.set(sid, v) }
    return m
  }, [raw, storeOf])

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
  const payments: Payment[] = useMemo(() => periodRaw.map(p => ({
    id: p.id, from: who(p), amount: money(p.amount), chainLabel: chainLabel(p.chain), chainLogo: chainLogoSrc(p.chain),
    time: p.createdAt, order: p.orderNumber ?? undefined,
    status: refundOf.has(p.id) ? 'refunded' as const
      : p.chain !== 'Arc_Testnet' && p.status !== 'collected' && waitingOn.has(p.chain) ? 'to_settle' as const : 'received' as const,
  })), [periodRaw, chains, refundOf])

  const today = useMemo(() => {
    const t = periodRaw.filter(p => !refundOf.has(p.id))
    const total = t.reduce((s, p) => s + p.amount, 0)
    const onArc = t.filter(p => p.chain === 'Arc_Testnet').reduce((s, p) => s + p.amount, 0)
    return { total, count: t.length, average: t.length ? total / t.length : 0, customers: new Set(t.map(who)).size, onArc }
  }, [periodRaw, refundOf])
  const trend = useMemo(() => periodTrend(today.total,
    storeRaw.filter(p => inPrevious(p.createdAt, period) && !refundOf.has(p.id)).reduce((s, p) => s + p.amount, 0)), [today.total, storeRaw, period, refundOf])
  const refundedInPeriod = refunds.filter(r => inPeriod(r.createdAt, period) && (!activeStore || storeRaw.some(p => p.id === r.paymentId)))
  const arcBalance = useWalletStore(s => s.balance)
  const autoSettle = useAutoSettle(settle.total)

  // ── Sheets ────────────────────────────────────────────────────────────
  const [detail, setDetail] = useState<Payment | null>(null)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [progressOpen, setProgressOpen] = useState(false)
  const [historyId, setHistoryId] = useState<string | null>(() => query.get('claim'))
  const [pin, setPin] = useState<{ kind: 'settle'; retry?: string[] } | { kind: 'one'; chainId: string } | { kind: 'refund' } | null>(null)
  const [pinError, setPinError] = useState<string | undefined>()

  const [screen, setScreen] = useState<ScreenId | null>(null)
  const open = (id: ScreenId) => () => setScreen(id)
  const back = () => setScreen(null)
  const go = (id: ScreenId) => () => { setMenu(false); setScreen(id) }

  const beginSettle = (retry?: string[]) => {
    if (settle.running) { setProgressOpen(true); return }
    if (settle.needsPasscode) { setPinError(undefined); setPin({ kind: 'settle', retry }); return }
    setProgressOpen(true)
    void settle.settle(undefined, retry)
  }
  const onPin = async (code: string) => {
    if (!await settle.checkPasscode(code)) { setPinError('Incorrect passcode. Try again.'); return }
    const p = pin
    setPin(null)
    if (p?.kind === 'refund') { void runRefund(code); return }
    if (p?.kind === 'one') { setProgressOpen(true); void settle.settleOne(p.chainId, code); return }
    setProgressOpen(true)
    void settle.settle(code, p?.kind === 'settle' ? p.retry : undefined)
  }

  /** Settle one chain (Settlements → On each chain → Settle). */
  const beginSettleOne = (chainId: string) => {
    if (settle.running) { setProgressOpen(true); return }
    if (settle.needsPasscode) { setPinError(undefined); setPin({ kind: 'one', chainId }); return }
    setProgressOpen(true)
    void settle.settleOne(chainId)
  }

  // ── Refund (MeshPortRefunds on Arc, signed on this device) ────────────
  const [refundFor, setRefundFor] = useState<MerchantPayment | null>(null)
  const [refundReason, setRefundReason] = useState(REFUND_REASONS[0])
  const [refundNote, setRefundNote] = useState('')
  const [refundDest, setRefundDest] = useState<RefundRoute>('arc')
  // USDC still on the payment's chain (the refund comes from there when it can).
  const [chainLeft, setChainLeft] = useState<number | null>(null)
  const [refundBusy, setRefundBusy] = useState(false)
  const [refundError, setRefundError] = useState<string>()
  const openRefund = (p: MerchantPayment) => {
    setRefundFor(p); setRefundReason(REFUND_REASONS[0]); setRefundNote(''); setRefundError(undefined)
    // Paid on another chain: refund from the USDC still on that chain.
    setChainLeft(null)
    if (p.chain === 'Arc_Testnet' || !walletAddress) { setRefundDest('arc'); return }
    setRefundDest('chain')
    chainUsdcBalance(p.chain, walletAddress).then(b => {
      setChainLeft(b)
      if (b !== null && b < p.amount) setRefundDest('arc')
    })
  }
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
      await refundPayment({ paymentId: refundFor.id, customer: refundFor.from, amount: refundFor.amount, reason, privateKey: key, route: refundDest, chain: refundFor.chain })
      await loadRefunds()
      toast(`Refunded ${money(refundFor.amount)} to ${who(refundFor)} on ${refundDest === 'chain' ? chainLabel(refundFor.chain) : 'Arc'}`, 'success')
      setRefundFor(null)
    } catch (e) { setRefundError(e instanceof Error ? e.message : 'Refund failed') }
    setRefundBusy(false)
  }
  const [receiptFor, setReceiptFor] = useState<MerchantPayment | null>(null)

  // Refund only to a person's own wallet: checked on the chain it was paid on.
  const [sender, setSender] = useState<{ id: string; check: SenderCheck | null } | null>(null)
  useEffect(() => {
    const p = detail ? raw.find(x => x.id === detail.id) : undefined
    if (!p) { setSender(null); return }
    let live = true
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

  const namedStore = application?.businessName || accountStoreName || null
  const storeName = namedStore || 'Your business'
  const storeInText = namedStore || 'your business'
  const handle = `${application?.username || username || 'store'}.arc`
  const headerStatus: VerificationStatus = isMerchant ? 'verified' : status === 'pending' ? 'review' : 'unverified'

  const banner = isMerchant ? undefined
    : status === 'pending'
      ? <SetupBanner tone="warning" title="Business account under review" text={`We're reviewing ${storeInText}. You'll get a notification when it's approved.`} action="View application" onAction={open('profile')} />
      : status === 'rejected' || status === 'revoked'
        ? <SetupBanner tone="danger" title={status === 'revoked' ? 'Merchant access removed' : 'Business account not approved'} text={application?.reviewNote || 'Check the details and send it again.'} action="Apply again" onAction={open('profile')} />
        : <SetupBanner tone="brand" title="Complete your business account" text={`Tell us why ${storeInText} needs a business account. Once approved, merchant tools turn on.`} action="Complete" onAction={open('profile')} />

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

  const rawDetail = detail ? raw.find(p => p.id === detail.id) : undefined
  const detailRefund = detail ? refundOf.get(detail.id) : undefined

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg">
      <div style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 8px)' }}>
        {tab === 'overview' ? (
          <BusinessHeader storeName={storeName} handle={handle} status={headerStatus} voiceOn={voice.enabled}
            onVoice={() => setVoiceOpen(true)} onMenu={() => setMenu(true)} onSwitchStore={stores.length ? () => setSwitcher(true) : undefined}
            outlet={stores.length > 1 ? (activeStore?.name ?? 'All stores') : null} />
        ) : (
          // Payments and Settlements open from Overview (See all, the settle
          // bar, the menu) and come back with the arrow - no tab bar.
          <header className="flex items-center gap-2 px-3 pt-4 pb-1">
            <button type="button" aria-label="Back to overview" onClick={() => { setPayFilter('all'); setTab('overview') }}
              className="size-11 flex items-center justify-center rounded-2xl text-text-secondary active:bg-border/40 transition-colors">
              <ArrowLeft className="size-5" />
            </button>
            <h1 className="text-lg font-semibold text-text-primary">{tab === 'payments' ? 'Payments' : 'Balance'}</h1>
            {tab === 'payments' && stores.length > 1 && <span className="ml-auto mr-2 text-xs text-text-muted truncate">{activeStore?.name ?? 'All stores'}</span>}
          </header>
        )}
        {tab === 'payments' && <div className="pt-2">
          <DateRangeBar value={periodSel.id} customLabel={period.id === 'custom' ? period.label : undefined}
            onChange={id => choosePeriod({ ...periodSel, id })} onCustom={() => setRangeSheet({ from: periodSel.from, to: periodSel.to })} />
        </div>}
      </div>

      <div className="flex-1 overflow-y-auto" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 96px)' }}>
        {tab === 'overview' && (
          <OverviewView loading={!loaded} banner={banner} periodLabel={period.label}
            collection={{ total: money(today.total), trend: <TrendChip pct={trend} compare={period.compareLabel} tone="onBrand" />, count: today.count, average: money(today.average), customers: today.customers }}
            toSettle={{ total: money(settle.total), chainCount: settle.due.length, chains: settle.due.map(c => ({ label: c.label, logo: c.logo })),
              checking: scanning, arcLogo: chainLogoSrc('Arc_Testnet') }}
            refunded={{ total: money(refundedInPeriod.reduce((s, r) => s + r.amount, 0)), count: refundedInPeriod.length }}
            recent={payments.slice(0, 4)}
            onShowQr={open('qr')} onReceive={open('receive')} onRequests={open('requests')} onBalance={() => setTab('settlements')}
            onToSettle={() => setTab('settlements')} onRefunded={() => { setPayFilter('refunded'); setTab('payments') }}
            onSeeAllPayments={() => { setPayFilter('all'); setTab('payments') }} onPayment={setDetail} onPeriod={() => setPeriodSheet(true)} />
        )}
        {tab === 'payments' && <PaymentsView key={payFilter} initialFilter={payFilter} loading={!loaded} payments={payments} onPayment={setDetail} />}
        {tab === 'settlements' && <div className="mx-5 mt-2 mb-1"><ArcBalanceCard amount={money(arcBalance)} note="Ready to spend, refund or cash out"
          action={<button type="button" onClick={open('cashout')} className="shrink-0 min-h-[40px] px-4 rounded-xl bg-brand text-white text-[13px] font-semibold active:opacity-90">Cash out</button>} /></div>}
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

      <PaymentDetailSheet payment={detail} explorerUrl={rawDetail ? explorerTxUrl(rawDetail.chain, rawDetail.txHash) ?? undefined : undefined}
        onClose={() => setDetail(null)} onSettle={() => { setDetail(null); setTab('settlements') }}
        onReceipt={() => { if (rawDetail) { setReceiptFor(rawDetail); setDetail(null); setScreen('receipt') } }}
        onRefund={rawDetail && sender?.id === rawDetail.id && sender.check?.refundable ? () => { openRefund(rawDetail); setDetail(null) } : undefined}
        refundNote={sender?.id === detail?.id ? (sender?.check ? sender.check.reason : 'Checking who sent this payment…') : undefined}
        refund={detailRefund ? { amount: money(detailRefund.amount), reason: detailRefund.reason, when: detailRefund.createdAt, txUrl: explorerTxUrl('Arc_Testnet', detailRefund.txHash) ?? undefined } : undefined} />

      <RefundSheet open={!!refundFor} amount={refundFor ? money(refundFor.amount) : ''} customer={refundFor ? who(refundFor) : ''}
        reasons={REFUND_REASONS} reason={refundReason} onReason={setRefundReason} note={refundNote} onNote={setRefundNote}
        busy={refundBusy} error={refundError} onConfirm={confirmRefund} onClose={() => { if (!refundBusy) setRefundFor(null) }}
        destinations={refundFor && refundFor.chain !== 'Arc_Testnet' ? [
          { id: 'chain', label: `From ${chainLabel(refundFor.chain)}`,
            hint: chainLeft === null ? `Checking your ${chainLabel(refundFor.chain)} balance…` : chainLeft >= refundFor.amount
              ? `Your ${money(chainLeft)} there · back to their wallet` : `Only ${money(chainLeft)} left there (settled)` },
          { id: 'arc', label: 'From Arc', hint: 'Your Arc balance · same wallet on Arc' },
        ] : undefined}
        destination={refundDest}
        onDestination={id => { if (id === 'chain' && refundFor && chainLeft !== null && chainLeft < refundFor.amount) return; setRefundDest(id as RefundRoute) }}
        note2={refundFor && refundDest === 'chain' ? `Sent from your USDC on ${chainLabel(refundFor.chain)} - MeshPort pays the gas.` : undefined} />

      <SettleProgressSheet open={progressOpen || !!historyClaim} running={progressOpen && settle.running} rows={progressRows}
        onClose={() => { setProgressOpen(false); setHistoryId(null) }}
        onRetryFailed={() => { if (failedIds.length) beginSettle(failedIds) }}
        onTrack={id => { const c = settle.run.find(r => r.id === id)?.claimId; if (c) { setProgressOpen(false); setHistoryId(c) } }} />

      <PasscodeSheet open={!!pin} title={pin?.kind === 'refund' ? 'Confirm refund' : 'Confirm settle'}
        subtitle={pin?.kind === 'refund' ? `Send ${refundFor ? money(refundFor.amount) : ''} back to ${refundFor ? who(refundFor) : 'the customer'}`
          : pin?.kind === 'one' ? `Move ${money((chains ?? []).find(c => c.id === pin.chainId)?.balance ?? 0)} from ${chainLabel(pin.chainId)} to Arc`
          : `Move ${money(pin?.kind === 'settle' && pin.retry ? settle.run.filter(r => pin.retry!.includes(r.id)).reduce((s, r) => s + r.balance, 0) : settle.total)} to your Arc balance`}
        error={pinError} onComplete={code => { void onPin(code) }} onClose={() => setPin(null)} />

      <VoiceSheet open={voiceOpen} enabled={voice.enabled} lang={voice.lang}
        langs={VOICE_LANGS.map(l => ({ id: l.id, label: l.label }))}
        onToggle={() => setVoiceAlerts({ enabled: !voice.enabled })} onLang={id => setVoiceAlerts({ lang: id as VoiceLang })}
        onTest={() => speakPayment(24, { test: true })} onClose={() => setVoiceOpen(false)} />

      <BusinessMenuSheet open={menu} onClose={() => setMenu(false)} groups={[
        { title: 'Business', items: [
          { id: 'reports', label: 'Reports', hint: 'Insights and statement · CSV and PDF', icon: 'insights', onClick: go('reports') },
          { id: 'team', label: 'Stores & staff', hint: stores.length ? `${stores.length} store${stores.length === 1 ? '' : 's'} · cashiers and managers` : 'Add outlets, invite cashiers', icon: 'stores', onClick: go('team') },
        ] },
        { title: 'Account', items: [
          { id: 'profile', label: 'Business profile', hint: headerStatus === 'verified' ? 'Verified' : 'Complete your application', icon: 'profile', onClick: go('profile') },
          { id: 'help', label: 'Help & disputes', hint: 'Customer says they paid', icon: 'help', onClick: go('help') },
        ] },
      ]} />

      <Sheet open={switcher} onClose={() => setSwitcher(false)}>
        <StoreSwitcher stores={[{ id: '', name: 'All stores', handle: `${stores.length} store${stores.length === 1 ? '' : 's'} together`, active: !activeStore, all: true },
          ...stores.map(s => ({ id: s.id, name: s.name, handle: `${s.isDefault ? 'Main store · ' : ''}${s.type ?? 'Store'}`, active: activeStore?.id === s.id }))]}
          onSwitch={id => pickStore(id || null)} onManage={() => { setSwitcher(false); setScreen('team') }} />
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
        onApply={() => { if (rangeSheet?.from && rangeSheet.to) choosePeriod({ id: 'custom', ...rangeSheet }); setRangeSheet(null) }}
        onClose={() => setRangeSheet(null)} />

      <PeriodSheet open={periodSheet} value={periodSel.id} customLabel={period.id === 'custom' ? period.label : undefined}
        onPick={id => { choosePeriod({ ...periodSel, id }); setPeriodSheet(false) }}
        onCustom={() => { setPeriodSheet(false); setRangeSheet({ from: periodSel.from, to: periodSel.to }) }}
        onClose={() => setPeriodSheet(false)} />

      <SettleDueSheet open={autoSettle.due && settle.due.length > 0 && !settle.running} amount={money(settle.total)}
        chains={settle.due.map(c => ({ label: c.label, logo: c.logo }))}
        onSettle={() => { autoSettle.dismiss(); setTab('settlements'); beginSettle() }} onLater={autoSettle.dismiss} />

      <RequestMaker.Provider value={{ create: createPaymentRequest, storeId: qrStore?.id ?? null, canBill: true }}>
      <ShopQrScreen open={screen === 'qr'} onBack={back} storeName={storeName} outlet={stores.length > 1 ? qrStore?.name : null} handle={handle} />
      <ReceiveScreen open={screen === 'receive'} onBack={back} storeName={storeName} />
      <RequestsScreen open={screen === 'requests'} onBack={back} />
      <ReportsScreen open={screen === 'reports'} onBack={back}
        insights={{ payments: storeRaw.filter(p => !refundOf.has(p.id)), waiting: money(settle.total), period, scope: stores.length > 1 ? activeStore?.name : null }}
        statement={{ storeName: stores.length > 1 && activeStore ? `${storeName} · ${activeStore.name}` : storeName, handle,
          payments: storeRaw, refunds: activeStore ? refunds.filter(r => storeRaw.some(p => p.id === r.paymentId)) : refunds,
          settled: (history ?? []).filter(c => c.status === 'completed').map(c => ({ amount: c.arrivedAmount ?? c.amount, createdAt: c.createdAt })),
          waiting: (chains ?? []).reduce((s, c) => s + c.balance, 0), loading: !loaded }} />
      <ReceiptScreen open={screen === 'receipt'} onBack={back} storeName={storeName} handle={handle} payment={receiptFor} refunded={!!(receiptFor && refundOf.has(receiptFor.id))} />
      <HelpScreen open={screen === 'help'} onBack={back} />
      <ProfileScreen open={screen === 'profile'} onBack={back} handle={handle} />
      </RequestMaker.Provider>
      <CashOutScreen open={screen === 'cashout'} onBack={back} />
      <TeamScreen open={screen === 'team'} onBack={back} canAddStores={isMerchant} stores={stores} onChanged={setStores} paymentsByStore={paymentsByStore}
        onQr={id => { pickStore(id); setScreen('qr') }} />
    </div>
  )
}
