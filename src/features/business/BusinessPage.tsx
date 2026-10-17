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
import { useAuthStore } from '@/store'
import { useMerchant } from '@/lib/merchant'
import { explorerTxUrl } from '@/lib/chainExplorers'
import { chainLogoSrc } from '@/lib/chainLogos'
import { listMyPayments, subscribeMerchantPayments, type MerchantPayment } from '@/lib/merchantPay'
import { useVoiceAlerts, setVoiceAlerts, speakPayment, VOICE_LANGS, type VoiceLang } from '@/lib/voiceAlerts'
import { useSettlement, useSettlementHistory, chainLabel, claimStage } from './settlement'
import { ShopQrScreen, ChargeScreen, LinkScreen, BillScreen, RequestsScreen, InsightsScreen, ProfileScreen } from './screens'
import {
  BusinessHeader, BusinessTabs, SetupBanner, OverviewView, PaymentsView, PaymentDetailSheet,
  SettlementsView, SettleProgressSheet, PasscodeSheet, VoiceSheet,
  type BusinessTab, type Payment, type VerificationStatus, type SettleProgressRow,
} from './ui'

type ScreenId = 'qr' | 'charge' | 'link' | 'bill' | 'requests' | 'insights' | 'profile'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const who = (p: MerchantPayment) => p.customerUsername ? `${p.customerUsername}.arc` : `${p.from.slice(0, 6)}…${p.from.slice(-4)}`
const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString()
const inWords = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export function BusinessPage() {
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

  // ── Payments (live; voice alert for each new one) ─────────────────────
  const [raw, setRaw] = useState<MerchantPayment[]>([])
  const [loaded, setLoaded] = useState(false)
  const seen = useRef<Set<string> | null>(null)
  const load = useCallback(async () => {
    const list = await listMyPayments(300)
    if (seen.current) for (const p of list) if (!seen.current.has(p.id)) speakPayment(p.amount)
    seen.current = new Set(list.map(p => p.id))
    setRaw(list); setLoaded(true)
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => (walletAddress ? subscribeMerchantPayments(walletAddress, () => { void load() }) : undefined), [walletAddress, load])

  // ── Settlements ───────────────────────────────────────────────────────
  const settle = useSettlement()
  const { chains } = settle
  const history = useSettlementHistory()
  const waitingOn = new Set((chains ?? []).map(c => c.id))

  // A payment on another chain is "to settle" while that chain still holds USDC.
  const payments: Payment[] = useMemo(() => raw.map(p => ({
    id: p.id, from: who(p), amount: money(p.amount), chainLabel: chainLabel(p.chain), chainLogo: chainLogoSrc(p.chain),
    time: p.createdAt, order: p.orderNumber ?? undefined,
    status: p.chain !== 'Arc_Testnet' && p.status !== 'collected' && waitingOn.has(p.chain) ? 'to_settle' as const : 'received' as const,
  })), [raw, chains])

  const today = useMemo(() => {
    const t = raw.filter(p => isToday(p.createdAt))
    const total = t.reduce((s, p) => s + p.amount, 0)
    const onArc = t.filter(p => p.chain === 'Arc_Testnet').reduce((s, p) => s + p.amount, 0)
    return { total, count: t.length, average: t.length ? total / t.length : 0, customers: new Set(t.map(who)).size, onArc }
  }, [raw])

  // ── Sheets ────────────────────────────────────────────────────────────
  const [detail, setDetail] = useState<Payment | null>(null)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [progressOpen, setProgressOpen] = useState(false)
  const [historyId, setHistoryId] = useState<string | null>(() => query.get('claim'))
  const [pin, setPin] = useState<{ retry?: string[] } | null>(null)
  const [pinError, setPinError] = useState<string | undefined>()

  const [screen, setScreen] = useState<ScreenId | null>(null)
  const open = (id: ScreenId) => () => setScreen(id)
  const back = () => setScreen(null)

  const beginSettle = (retry?: string[]) => {
    if (settle.running) { setProgressOpen(true); return }
    if (settle.needsPasscode) { setPinError(undefined); setPin({ retry }); return }
    setProgressOpen(true)
    void settle.settle(undefined, retry)
  }
  const onPin = async (code: string) => {
    if (!await settle.checkPasscode(code)) { setPinError('Incorrect passcode. Try again.'); return }
    const retry = pin?.retry
    setPin(null); setProgressOpen(true)
    void settle.settle(code, retry)
  }

  // ── Labels ────────────────────────────────────────────────────────────
  const scanning = chains === undefined || !settle.checked
  const settleLabel = scanning ? 'Checking chains…'
    : settle.running ? 'Settling…'
    : !settle.ready ? `Next settle in ${inWords(settle.nextAt - Date.now())}`
    : settle.due.length === 0 ? 'Nothing to settle'
    : `Settle ${money(settle.total)} to Arc`
  const settleNote = `Uses CCTP. MeshPort pays the gas.${settle.waitHours ? ` Once every ${settle.waitHours} hour${settle.waitHours === 1 ? '' : 's'}.` : ''}`

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
  const historyItems = (history ?? []).slice(0, 20).map(c => ({
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

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg">
      <div style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 8px)' }}>
        <BusinessHeader storeName={storeName} handle={handle} status={headerStatus} voiceOn={voice.enabled}
          onVoice={() => setVoiceOpen(true)} onProfile={open('profile')} />
        <BusinessTabs tab={tab} onTab={setTab} settleCount={settle.due.length} />
      </div>

      <div className="flex-1 overflow-y-auto" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 96px)' }}>
        {tab === 'overview' && (
          <OverviewView loading={!loaded}
            today={{ total: money(today.total), count: today.count, average: money(today.average), customers: today.customers }}
            onArc={money(today.onArc)} toSettle={{ total: money(settle.total), chainCount: settle.due.length }}
            recent={payments.slice(0, 4)} banner={banner}
            onShowQr={open('qr')} onCharge={open('charge')}
            onPaymentLink={open('link')} onSendBill={open('bill')}
            onRequests={open('requests')} onSettle={() => setTab('settlements')}
            onSeeAllPayments={() => setTab('payments')} onPayment={setDetail}
            onInsights={open('insights')} onVoiceAlerts={() => setVoiceOpen(true)} onProfile={open('profile')} />
        )}
        {tab === 'payments' && <PaymentsView loading={!loaded} payments={payments} onPayment={setDetail} />}
        {tab === 'settlements' && (
          <SettlementsView scanning={scanning}
            chains={(chains ?? []).map(c => ({ id: c.id, label: c.label, logo: c.logo, balance: money(c.balance) }))}
            total={money(settle.total)}
            settle={{ enabled: !scanning && settle.ready && !settle.running && settle.due.length > 0, label: settleLabel, note: settleNote }}
            onSettle={() => beginSettle()} onRefresh={settle.rescan}
            history={historyItems} onHistory={id => { setProgressOpen(false); setHistoryId(id) }}
            lastRun={settle.run.length ? { running: settle.running, onOpen: () => { setHistoryId(null); setProgressOpen(true) } } : undefined} />
        )}
      </div>

      <PaymentDetailSheet payment={detail} explorerUrl={rawDetail ? explorerTxUrl(rawDetail.chain, rawDetail.txHash) ?? undefined : undefined}
        onClose={() => setDetail(null)} onSettle={() => { setDetail(null); setTab('settlements') }} />

      <SettleProgressSheet open={progressOpen || !!historyClaim} running={progressOpen && settle.running} rows={progressRows}
        onClose={() => { setProgressOpen(false); setHistoryId(null) }}
        onRetryFailed={() => { if (failedIds.length) beginSettle(failedIds) }}
        onTrack={id => { const c = settle.run.find(r => r.id === id)?.claimId; if (c) { setProgressOpen(false); setHistoryId(c) } }} />

      <PasscodeSheet open={!!pin} title="Confirm settle" subtitle={`Move ${money(pin?.retry ? settle.run.filter(r => pin.retry!.includes(r.id)).reduce((s, r) => s + r.balance, 0) : settle.total)} to your Arc balance`}
        error={pinError} onComplete={code => { void onPin(code) }} onClose={() => setPin(null)} />

      <VoiceSheet open={voiceOpen} enabled={voice.enabled} lang={voice.lang}
        langs={VOICE_LANGS.map(l => ({ id: l.id, label: l.label }))}
        onToggle={() => setVoiceAlerts({ enabled: !voice.enabled })} onLang={id => setVoiceAlerts({ lang: id as VoiceLang })}
        onTest={() => speakPayment(24, { test: true })} onClose={() => setVoiceOpen(false)} />

      <ShopQrScreen open={screen === 'qr'} onBack={back} storeName={storeName} handle={handle} />
      <ChargeScreen open={screen === 'charge'} onBack={back} />
      <LinkScreen open={screen === 'link'} onBack={back} storeName={storeName} />
      <BillScreen open={screen === 'bill'} onBack={back} storeName={storeName} />
      <RequestsScreen open={screen === 'requests'} onBack={back} />
      <InsightsScreen open={screen === 'insights'} onBack={back} payments={raw} />
      <ProfileScreen open={screen === 'profile'} onBack={back} handle={handle} />
    </div>
  )
}
