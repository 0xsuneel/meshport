// Business → staff mode: what a cashier or manager sees on their own phone.
// They take payments that go straight to the business they work for
// (staff_create_request) and see its payments (staff_payments: cashiers
// today only). No balances, refunds, settlements or cash out - those stay
// with the owner. Pending invites are accepted here.
import { useEffect, useMemo, useState } from 'react'
import { useUIStore } from '@/store'
import { chainLogoSrc } from '@/lib/chainLogos'
import { myMemberships, acceptInvite, staffCreateRequest, staffPayments, type Membership } from '@/lib/businessTeam'
import type { MerchantPayment } from '@/lib/merchantPay'
import { RequestMaker, ShopQrScreen, ReceiveScreen } from './screens'
import { setDueDate } from '@/lib/businessBills'
import { logBusiness } from '@/lib/businessActivity'
import { StaffBanner, StaffModeHeader, PaymentsView, OverviewView, Skeleton, type Payment } from './ui'
import { chainLabel } from './settlement'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const who = (p: MerchantPayment) => p.customerUsername ? `${p.customerUsername}.arc` : `${p.from.slice(0, 6)}…${p.from.slice(-4)}`

export function StaffModePage() {
  const toast = useUIStore(s => s.showToastMessage)
  const [list, setList] = useState<Membership[] | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [raw, setRaw] = useState<MerchantPayment[]>([])
  const [screen, setScreen] = useState<'qr' | 'receive' | 'payments' | null>(null)

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
    chainLogo: chainLogoSrc(p.chain), time: p.createdAt, order: p.orderNumber ?? undefined, status: 'received' as const })), [raw])
  const today = raw.filter(p => new Date(p.createdAt).toDateString() === new Date().toDateString())
  const total = today.reduce((s, p) => s + p.amount, 0)

  if (!list) return <div className="p-5"><Skeleton className="h-40 w-full" /></div>

  if (!active) return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto bg-bg px-5" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 20px)', paddingBottom: 120 }}>
      <h1 className="text-xl font-bold text-text-primary">Business</h1>
      {list.length === 0 && <p className="text-sm text-text-secondary">Business is for business accounts. If a shop added you as staff, their invite shows here.</p>}
      {list.map(m => (
        <StaffBanner key={m.id} ownerStore={m.storeName ? `${m.ownerName} · ${m.storeName}` : m.ownerName} role={m.role}
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
  return (
    <div className="flex flex-col h-full min-h-0 bg-bg">
      <div style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 8px)' }}>
        <StaffModeHeader store={active.storeName ? `${active.ownerName} · ${active.storeName}` : active.ownerName} role={active.role} onExit={() => setActiveId(null)} />
      </div>
      <div className="flex-1 overflow-y-auto" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 96px)' }}>
        <OverviewView loading={false} periodLabel="Today"
          collection={{ total: money(total), count: today.length, average: money(today.length ? total / today.length : 0), customers: new Set(today.map(who)).size }}
          toSettle={{ total: '—', chainCount: 0, hidden: true }} refunded={{ total: '—', count: 0 }} recent={payments.slice(0, 4)}
          onShowQr={() => setScreen('qr')} onReceive={() => setScreen('receive')}
          onToSettle={() => toast('Settlements are done by the owner', 'info')}
          onRefunded={() => toast('Refunds are done by the owner', 'info')}
          onSeeAllPayments={() => setScreen('payments')} onPayment={() => {}} />
      </div>
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
      {screen === 'payments' && (
        <div className="fixed inset-0 z-40 bg-bg overflow-y-auto" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}>
          <button type="button" onClick={back} className="mx-4 mb-2 min-h-[44px] text-sm font-semibold text-brand-text">‹ Back</button>
          <PaymentsView loading={false} payments={payments} onPayment={() => {}} />
        </div>
      )}
    </div>
  )
}
