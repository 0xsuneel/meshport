// Business → staff mode: what a cashier or manager sees on their own phone.
// They take payments that go straight to the business they work for
// (staff_create_request) and see its payments (staff_payments: cashiers
// today only). Managers also get the store's Requests (staff_intents) and a
// Statement (with staff_refunds). No balances, refunds, settlements or cash
// out - those stay with the owner. Pending invites are accepted here.
import { DesktopTwoColumn } from '@/components/layout/DesktopTwoColumn'
import { useEffect, useMemo, useState } from 'react'
import { useUIStore } from '@/store'
import { chainLogoSrc } from '@/lib/chainLogos'
import { myMemberships, acceptInvite, staffCreateRequest, staffPayments, staffRefunds, type Membership } from '@/lib/businessTeam'
import type { MerchantRefund } from '@/lib/merchantRefunds'
import { ChevronRight, ClipboardList, FileText, QrCode, BadgeDollarSign, ReceiptText, ListChecks } from 'lucide-react'
import { myAuthUid, type MerchantPayment } from '@/lib/merchantPay'
import { RequestMaker, ShopQrScreen, ReceiveScreen, RequestsList, StatementBody } from './screens'
import { setDueDate } from '@/lib/businessBills'
import { listCounters, counterQrUrl, type Counter } from '@/lib/businessCounters'
import { StaffCheckIn } from './creditStaff'
import { logBusiness } from '@/lib/businessActivity'
import { StaffBanner, StaffModeHeader, PaymentsView, BizHomeView, PaymentRow, Skeleton, BusinessScreen, useHubShift, type Payment } from './ui'
import { chainLabel } from './settlement'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DESKTOP_QUERY, PUSH_OPEN_MS } from '@/lib/motion'
import { useStatusBarTint } from '@/lib/statusBarTint'
import { useThemeStore, resolveTheme } from '@/store/themeStore'
import { DesktopHistoryPanel, DesktopHistoryEmpty } from '@/components/ui/DesktopHistoryPanel'
import { errorText } from '@/lib/errorText'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const who = (p: MerchantPayment) => p.customerUsername ? `${p.customerUsername}.arc` : `${p.from.slice(0, 6)}…${p.from.slice(-4)}`

export function StaffModePage() {
  const toast = useUIStore(s => s.showToastMessage)
  const [list, setList] = useState<Membership[] | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [raw, setRaw] = useState<MerchantPayment[]>([])
  const [screen, setScreen] = useState<'qr' | 'receive' | 'payments' | 'requests' | 'statement' | null>(null)
  const [me, setMe] = useState<string | null>(null)
  // The counters this staff member is added to (only theirs are visible to them).
  const [myCounters, setMyCounters] = useState<Counter[]>([])
  useEffect(() => { listCounters().then(setMyCounters).catch(() => {}) }, [])
  // Charge or Bill: each its own page, like the owner's.
  const [collect, setCollect] = useState<'charge' | 'bill'>('charge')
  useEffect(() => { void myAuthUid().then(setMe) }, [])
  const [refunds, setRefunds] = useState<MerchantRefund[]>([])
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  const themeMode = useThemeStore(t => t.mode)
  const bandTint = !isDesktop && !!activeId ? (resolveTheme(themeMode) === 'dark' ? '#0E4F49' : '#12665F') : null
  useStatusBarTint(bandTint, () => PUSH_OPEN_MS)

  const load = () => {
    if (import.meta.env.VITE_E2E === '1') {
      try {
        const role = localStorage.getItem('meshport_e2e_staff')
        if (role === 'cashier' || role === 'manager') {
          setList([{ id: 'e2e', role, status: 'active', ownerName: 'Sharma General Store', storeName: null, ownerAuthUid: 'o', ownerUsername: 'shop', storeId: null, storePublicName: null } as unknown as Membership])
          return Promise.resolve()
        }
      } catch { /* storage off */ }
    }
    return myMemberships().then(setList).catch(() => setList([]))
  }
  useEffect(() => { void load() }, [])
  const active = list?.find(m => m.id === activeId && m.status === 'active') ?? null
  useEffect(() => {
    if (!active) return
    const get = () => staffPayments(active.ownerAuthUid).then(setRaw).catch(() => {})
    void get()
    const t = setInterval(get, 15_000)
    return () => clearInterval(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately re-runs only on the listed values
  }, [active?.id])

  const payments: Payment[] = useMemo(() => raw.map(p => ({ id: p.id, from: who(p), amount: money(p.amount), chainLabel: chainLabel(p.chain),
    chainLogo: chainLogoSrc(p.chain), time: p.createdAt, late: !!p.late, blocked: !!p.screenFlag, status: 'received' as const })), [raw])
  const today = raw.filter(p => new Date(p.createdAt).toDateString() === new Date().toDateString())
  const total = today.reduce((s, p) => s + p.amount, 0)
  // Like the owner's hub: the home (and the bottom tab bar) parallaxes left
  // under a Business screen pushed over it (phone only).
  const homeShift = useHubShift(!isDesktop && !!active && !!screen)

  if (!list) return <div className="p-5"><Skeleton className="h-40 w-full" /></div>

  if (!active) return (
    <div className={`flex flex-col gap-4 h-full overflow-y-auto bg-bg ${isDesktop ? 'px-10' : 'px-5'}`} style={{ paddingTop: isDesktop ? 20 : 'calc(var(--safe-top) + 20px)', paddingBottom: isDesktop ? 24 : 120 }}>
      <h1 className="text-xl font-bold text-text-primary">Business</h1>
      {list.length === 0 && <p className="text-sm text-text-secondary">Business is for business accounts. If a shop added you as staff, their invite shows here.</p>}
      {list.map(m => (
        <StaffBanner key={m.id} ownerStore={m.storeName ? `${m.ownerName} · ${m.storeName}` : m.ownerName} role={m.role} invited={m.status === 'invited'}
          onOpen={async () => {
            if (m.status === 'invited') {
              try { await acceptInvite(m.id); toast(`You joined ${m.ownerName}`, 'success'); await load() }
              catch (e) { toast(errorText(e, 'Could not accept'), 'error'); return }
            }
            setActiveId(m.id)
          }} />
      ))}
    </div>
  )

  const manager = active.role === 'manager'
  const myCounter = myCounters.find(c => !active.storeId || !c.storeId || c.storeId === active.storeId) ?? null
  const back = () => setScreen(null)
  const openStatement = () => { setScreen('statement'); void staffRefunds(active.ownerAuthUid).then(setRefunds).catch(() => setRefunds([])) }
  const where = active.storeName ? `${active.ownerName} · ${active.storeName}` : active.ownerName
  const row = (icon: React.ReactNode, label: string, hint: string, onClick: () => void) => (
    <button type="button" onClick={onClick} className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-card">
      <span className="size-9 rounded-xl flex items-center justify-center bg-brand/10 text-brand-text shrink-0">{icon}</span>
      <span className="flex-1 min-w-0"><span className="block text-sm font-semibold text-text-primary">{label}</span><span className="block text-xs text-text-muted truncate">{hint}</span></span>
      <ChevronRight className="size-4 text-text-muted shrink-0" />
    </button>
  )
  // Desktop: the owner's Business layout (the shared DesktopTwoColumn) - this
  // column, today's payments on the right; its screens open inside the column
  // (a stage: PushLayer is absolute).
  return (
    <DesktopTwoColumn isDesktop={isDesktop} stage className="bg-bg"
      phoneMainClassName="flex flex-col h-full min-h-0 bg-bg"
      main={<>
      <div className="flex-1 min-h-0 flex flex-col" style={homeShift}>
      {/* The business look (27 Nov): the owner's Home, limited by role - the
          store on the teal band, today's sales, the ways to get paid
          (cashier: QR, Charge, Payments; manager: Bill too) and the latest
          payments. No balances, settling or cash out: those are the owner's. */}
      <div className="flex-1 overflow-y-auto relative" style={{ paddingBottom: isDesktop ? 24 : 'calc(var(--safe-bottom) + 96px)' }}>
        {!isDesktop && <div aria-hidden className="absolute left-0 right-0 top-0 pointer-events-none" style={{ height: 'calc(var(--safe-top) + 235px)', background: 'var(--home-band)' }} />}
        <div className="relative" style={{ paddingTop: isDesktop ? 0 : 'var(--safe-top)' }}>
          <StaffModeHeader onBand={!isDesktop} store={active.storeName ? `${active.ownerName} · ${active.storeName}` : active.ownerName} role={active.role} onExit={() => setActiveId(null)} />
        </div>
        {/* Check in / out for the shift (28 Nov). */}
        <div className="relative mb-3"><StaffCheckIn owner={active.ownerAuthUid} counterName={myCounter?.name ?? null} /></div>
        <BizHomeView loading={false} periodLabel="Today" total={money(total)}
          stats={{ count: today.length, average: money(today.length ? total / today.length : 0), openOrders: null }}
          third={{ value: new Set(today.map(who)).size, label: 'Customers' }}
          hideMoney attention={[]}
          quick={[
            { id: 'qr', icon: QrCode, label: 'Show QR', tint: 'mint', onClick: () => setScreen('qr') },
            { id: 'charge', icon: BadgeDollarSign, label: 'Charge', tint: 'butter', onClick: () => { setCollect('charge'); setScreen('receive') } },
            ...(manager ? [{ id: 'bill', icon: ReceiptText, label: 'Bill', tint: 'peach', onClick: () => { setCollect('bill'); setScreen('receive') } }] : []),
            { id: 'payments', icon: ListChecks, label: 'Payments', tint: manager ? 'mint' : 'peach', onClick: () => setScreen('payments') },
          ]}
          recent={payments.slice(0, 5)} onSeeAll={() => setScreen('payments')} onPayment={() => {}} hideRecent={isDesktop}
          emptyHint="Show the QR at the counter to take the first payment" />
        {/* Managers: the store's requests and its statement. */}
        {manager && (
          <div className="mx-5 mt-1 rounded-[20px] bg-card border border-border overflow-hidden divide-y divide-border">
            {row(<ClipboardList className="size-[18px]" />, 'Requests', 'Requests and bills · share, cancel your own', () => setScreen('requests'))}
            {row(<FileText className="size-[18px]" />, 'Statement', 'CSV or PDF of the store\'s payments', openStatement)}
          </div>
        )}
      </div>
      </div>
      {manager && (
        <>
          <BusinessScreen open={screen === 'requests'} title="Requests" onBack={back}>
            <RequestsList active={screen === 'requests'} storeName={where} staff={{ owner: active.ownerAuthUid, me }} />
          </BusinessScreen>
          <BusinessScreen open={screen === 'statement'} title="Statement" onBack={back}>
            <StatementBody storeName={where} handle={`${active.ownerUsername}.arc`} payments={raw} refunds={refunds}
              settled={[]} waiting={0} loading={false} staff />
          </BusinessScreen>
        </>
      )}
      <RequestMaker.Provider value={{
        create: async p => {
          const i = await staffCreateRequest(active.ownerAuthUid, { ...p, storeId: p.storeId ?? active.storeId })
          // A manager's bill can carry a due date (set right after it's made).
          if (p.dueDate) { await setDueDate(i.id, p.dueDate).catch(() => toast('Bill made, but the due date was not saved', 'error')); return { ...i, dueDate: p.dueDate } }
          return i
        },
        storeId: active.storeId, canBill: manager, savedItems: false,
        // Staff actions go into the owner's activity log.
        log: (action, x) => { void logBusiness(action, { ...x, owner: active.ownerAuthUid }) },
      }}>
        <ShopQrScreen open={screen === 'qr'} onBack={back} storeName={active.ownerName} outlet={active.storePublicName} handle={`${active.ownerUsername}.arc`} payTo={active.ownerUsername}
          // Staff at a counter show that counter's QR (its payments name the counter).
          {...(myCounter ? { url: counterQrUrl(window.location.origin, active.ownerUsername, myCounter), place: { label: 'Counter', value: myCounter.name } } : {})} />
        <ReceiveScreen key={collect} only={collect} open={screen === 'receive'} onBack={back} storeName={active.ownerName} />
      </RequestMaker.Provider>
      {/* Same page push and header as every other Business screen. */}
      <BusinessScreen open={screen === 'payments'} title="Payments" onBack={back}>
        <PaymentsView loading={false} payments={payments} onPayment={() => {}} />
      </BusinessScreen>
      </>}
      side={
        <DesktopHistoryPanel title="Recent payments" onViewAll={payments.length ? () => setScreen('payments') : undefined}>
          {payments.length === 0 ? <DesktopHistoryEmpty label="No payments yet - show your QR at the counter to get paid" />
            : <div className="divide-y divide-border">{payments.slice(0, 30).map(p => <PaymentRow key={p.id} payment={p} onClick={() => {}} />)}</div>}
        </DesktopHistoryPanel>
      } />
  )
}
