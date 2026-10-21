// Business → staff mode: what a cashier or manager sees on their own phone.
// They take payments that go straight to the business they work for
// (staff_create_request) and see its payments (staff_payments: cashiers
// today only). Managers also get the store's Requests (staff_intents) and a
// Statement (with staff_refunds). No balances, refunds, settlements or cash
// out - those stay with the owner. Pending invites are accepted here.
import { useEffect, useMemo, useState } from 'react'
import { useUIStore } from '@/store'
import { chainLogoSrc } from '@/lib/chainLogos'
import { myMemberships, acceptInvite, staffCreateRequest, staffPayments, staffRefunds, type Membership } from '@/lib/businessTeam'
import type { MerchantRefund } from '@/lib/merchantRefunds'
import { ChevronRight, ClipboardList, FileText } from 'lucide-react'
import { displayOrderNumber, myAuthUid, type MerchantPayment } from '@/lib/merchantPay'
import { RequestMaker, ShopQrScreen, ReceiveScreen, RequestsList, StatementBody } from './screens'
import { setDueDate } from '@/lib/businessBills'
import { logBusiness } from '@/lib/businessActivity'
import { StaffBanner, StaffModeHeader, PaymentsView, OverviewView, PaymentRow, Skeleton, BusinessScreen, type Payment } from './ui'
import { chainLabel } from './settlement'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DESKTOP_QUERY } from '@/lib/motion'
import { DesktopHistoryPanel, DesktopHistoryEmpty } from '@/components/ui/DesktopHistoryPanel'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const who = (p: MerchantPayment) => p.customerUsername ? `${p.customerUsername}.arc` : `${p.from.slice(0, 6)}…${p.from.slice(-4)}`

export function StaffModePage() {
  const toast = useUIStore(s => s.showToastMessage)
  const [list, setList] = useState<Membership[] | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [raw, setRaw] = useState<MerchantPayment[]>([])
  const [screen, setScreen] = useState<'qr' | 'receive' | 'payments' | 'requests' | 'statement' | null>(null)
  const [me, setMe] = useState<string | null>(null)
  useEffect(() => { void myAuthUid().then(setMe) }, [])
  const [refunds, setRefunds] = useState<MerchantRefund[]>([])
  const isDesktop = useMediaQuery(DESKTOP_QUERY)

  const load = () => myMemberships().then(setList).catch(() => setList([]))
  useEffect(() => { void load() }, [])
  const active = list?.find(m => m.id === activeId && m.status === 'active') ?? null
  useEffect(() => {
    if (!active) return
    const get = () => staffPayments(active.ownerAuthUid).then(setRaw).catch(() => {})
    void get()
    const t = setInterval(get, 15_000)
    return () => clearInterval(t)
  }, [active?.id])

  const payments: Payment[] = useMemo(() => raw.map(p => ({ id: p.id, from: who(p), amount: money(p.amount), chainLabel: chainLabel(p.chain),
    chainLogo: chainLogoSrc(p.chain), time: p.createdAt, order: p.orderNumber ? displayOrderNumber(p.orderNumber) : undefined, late: !!p.late, blocked: !!p.screenFlag, status: 'received' as const })), [raw])
  const today = raw.filter(p => new Date(p.createdAt).toDateString() === new Date().toDateString())
  const total = today.reduce((s, p) => s + p.amount, 0)

  if (!list) return <div className="p-5"><Skeleton className="h-40 w-full" /></div>

  if (!active) return (
    <div className={`flex flex-col gap-4 h-full overflow-y-auto bg-bg ${isDesktop ? 'px-10' : 'px-5'}`} style={{ paddingTop: isDesktop ? 20 : 'calc(env(safe-area-inset-top, 0px) + 20px)', paddingBottom: isDesktop ? 24 : 120 }}>
      <h1 className="text-xl font-bold text-text-primary">Business</h1>
      {list.length === 0 && <p className="text-sm text-text-secondary">Business is for business accounts. If a shop added you as staff, their invite shows here.</p>}
      {list.map(m => (
        <StaffBanner key={m.id} ownerStore={m.storeName ? `${m.ownerName} · ${m.storeName}` : m.ownerName} role={m.role} invited={m.status === 'invited'}
          onOpen={async () => {
            if (m.status === 'invited') {
              try { await acceptInvite(m.id); toast(`You joined ${m.ownerName}`, 'success'); await load() }
              catch (e) { toast(e instanceof Error ? e.message : 'Could not accept', 'error'); return }
            }
            setActiveId(m.id)
          }} />
      ))}
    </div>
  )

  const manager = active.role === 'manager'
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
  // Desktop: the owner's Business layout - this column, today's payments on
  // the right; its screens open inside the column (PushLayer is absolute).
  return (
    <div className={isDesktop ? 'flex h-full min-h-0 bg-bg gap-7 px-6 pt-5 pb-3.5 box-border' : 'contents'}>
    <div className={isDesktop ? 'relative flex-[65_1_0%] min-w-0 min-h-0 flex flex-col overflow-hidden' : 'flex flex-col h-full min-h-0 bg-bg'}>
      <div style={{ paddingTop: isDesktop ? 0 : 'calc(env(safe-area-inset-top, 0px) + 8px)' }}>
        <StaffModeHeader store={active.storeName ? `${active.ownerName} · ${active.storeName}` : active.ownerName} role={active.role} onExit={() => setActiveId(null)} />
      </div>
      <div className="flex-1 overflow-y-auto" style={{ paddingBottom: isDesktop ? 24 : 'calc(env(safe-area-inset-bottom, 0px) + 96px)' }}>
        <OverviewView loading={false} periodLabel="Today" hideRecent={isDesktop}
          collection={{ total: money(total), count: today.length, average: money(today.length ? total / today.length : 0), customers: new Set(today.map(who)).size }}
          toSettle={{ total: '—', chainCount: 0, hidden: true }} refunded={{ total: '—', count: 0 }} recent={payments.slice(0, 4)}
          onShowQr={() => setScreen('qr')} onReceive={() => setScreen('receive')}
          onToSettle={() => toast('Settlements are done by the owner', 'info')}
          onRefunded={() => toast('Refunds are done by the owner', 'info')}
          onSeeAllPayments={() => setScreen('payments')} onPayment={() => {}} />
        {/* Managers: the store's requests and its statement. */}
        {manager && (
          <div className="mx-5 mt-4 rounded-2xl bg-surface border border-border overflow-hidden divide-y divide-border">
            {row(<ClipboardList className="size-[18px]" />, 'Requests', 'Requests and bills · share, cancel your own', () => setScreen('requests'))}
            {row(<FileText className="size-[18px]" />, 'Statement', 'CSV or PDF of the store\'s payments', openStatement)}
          </div>
        )}
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
        <ShopQrScreen open={screen === 'qr'} onBack={back} storeName={active.ownerName} outlet={active.storeName} handle={`${active.ownerUsername}.arc`} payTo={active.ownerUsername} />
        <ReceiveScreen open={screen === 'receive'} onBack={back} storeName={active.ownerName} />
      </RequestMaker.Provider>
      {/* Same page push and header as every other Business screen. */}
      <BusinessScreen open={screen === 'payments'} title="Payments" onBack={back}>
        <PaymentsView loading={false} payments={payments} onPayment={() => {}} />
      </BusinessScreen>
    </div>
      {isDesktop && (
        <div className="flex-[35_1_0%] min-w-0 min-h-0">
          <DesktopHistoryPanel title="Recent payments" onViewAll={payments.length ? () => setScreen('payments') : undefined}>
            {payments.length === 0 ? <DesktopHistoryEmpty label="No payments yet - show your QR at the counter to get paid" />
              : <div className="divide-y divide-border">{payments.slice(0, 30).map(p => <PaymentRow key={p.id} payment={p} onClick={() => {}} />)}</div>}
          </DesktopHistoryPanel>
        </div>
      )}
    </div>
  )
}
