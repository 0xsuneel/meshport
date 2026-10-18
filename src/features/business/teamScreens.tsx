// Business → Cash out to bank (INR), Stores & outlets, Staff & roles.
// Visuals from the Arc Studio kit in ./ui; money and data from
// lib/businessCashOut (P2P marketplace + escrow) and lib/businessTeam.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuthStore, useUIStore, useWalletStore } from '@/store'
import {
  listBuyers, buyerMax, startCashOut, listCashOuts, fetchTrade, releaseTrade, cancelTrade, canCancelTrade, openDispute,
  fetchMyPaymentMethods, savePaymentMethod, fetchTradeMessages, sendTradeMessage, subscribeToTradeMessages, subscribeToTradeUpdates,
  paymentMethodSummary, inr, type BuyerOffer, type P2PTrade, type P2PPaymentMethod, type P2PMessage,
} from '@/lib/businessCashOut'
import { listStores, saveStore, deleteStore, listStaff, inviteStaff, updateStaff, removeStaff, type Store, type StaffMember, type StaffRole } from '@/lib/businessTeam'
import { BUSINESS_CATEGORIES, useBizTerms } from '@/lib/businessCategories'
import {
  BusinessScreen, CashOutHero, CashOutAmount, BuyerOfferList, PayoutAccountPicker, PayoutAccountForm, CashOutTradeView, CashOutHistory,
  StoresView, StoreForm, StaffView, StaffForm, PasscodeSheet, PrimaryBtn, Skeleton,
  type PayoutMethod, type TradeStage, type CashOutHistoryStatus,
} from './ui'
import { unlockKey } from './settlement'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Passcode gate for money moves (same check as Settle and Refund). */
function usePasscodeGate() {
  const hash = useAuthStore(s => s.passcode)
  const [pending, setPending] = useState<{ title: string; subtitle: string; run: (code?: string) => void } | null>(null)
  const [error, setError] = useState<string>()
  const ask = (title: string, subtitle: string, run: (code?: string) => void) => { if (!hash) { run(); return } setError(undefined); setPending({ title, subtitle, run }) }
  const sheet = (
    <PasscodeSheet open={!!pending} title={pending?.title ?? ''} subtitle={pending?.subtitle ?? ''} error={error}
      onClose={() => setPending(null)}
      onComplete={async code => {
        const { verifyPasscode } = await import('@/lib/security')
        if (!hash || !await verifyPasscode(code, hash)) { setError('Incorrect passcode. Try again.'); return }
        const p = pending; setPending(null); p?.run(code)
      }} />
  )
  return { ask, sheet }
}

// ── Cash out to bank (INR) ───────────────────────────────────────────────

const STAGE: Record<P2PTrade['status'], TradeStage> = {
  awaiting_seller_confirmation: 'escrow', waiting_for_buyer: 'waiting_payment', payment_sent: 'payment_sent',
  released: 'released', completed: 'released', cancelled: 'cancelled', expired: 'cancelled',
}
const historyStatus = (t: P2PTrade): CashOutHistoryStatus => t.disputeStatus === 'open' ? 'disputed'
  : t.status === 'released' || t.status === 'completed' ? 'completed' : t.status === 'cancelled' || t.status === 'expired' ? 'cancelled' : 'active'

export function CashOutScreen({ open, onBack }: { open: boolean; onBack: () => void }) {
  const toast = useUIStore(s => s.showToastMessage)
  const user = useAuthStore(s => s.user)
  const wallet = useAuthStore(s => s.walletAddress)
  const arc = useWalletStore(s => s.balance)
  const gate = usePasscodeGate()
  const [buyers, setBuyers] = useState<BuyerOffer[] | null>(null)
  const [selected, setSelected] = useState<string>()
  const [amount, setAmount] = useState('')
  const [accounts, setAccounts] = useState<P2PPaymentMethod[]>([])
  const [account, setAccount] = useState<string>()
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<{ method: PayoutMethod; holder: string; f: Record<string, string> }>({ method: 'UPI', holder: '', f: {} })
  const [busy, setBusy] = useState(false)
  const [trades, setTrades] = useState<P2PTrade[]>([])
  const [tradeId, setTradeId] = useState<string | null>(null)

  const load = () => {
    if (!user?.id) return
    listBuyers(user.id).then(b => { setBuyers(b); setSelected(s => s ?? b[0]?.offer.id) }).catch(() => setBuyers([]))
    fetchMyPaymentMethods(user.id).then(a => { setAccounts(a); setAccount(x => x ?? a[0]?.id) }).catch(() => {})
    listCashOuts(user.id).then(setTrades).catch(() => {})
  }
  useEffect(() => { if (open) load() }, [open, user?.id])

  const buyer = buyers?.find(b => b.offer.id === selected)
  const value = Number(amount) || 0
  const best = buyers?.[0]
  const rate = buyer?.offer.pricePerUsdc ?? best?.offer.pricePerUsdc ?? 0
  const err = !value ? undefined : value > arc ? 'More than your Arc balance'
    : buyer && value < buyer.offer.minAmount ? `This buyer takes at least ${buyer.offer.minAmount} USDC`
    : buyer && value > buyerMax(buyer) ? `This buyer takes up to ${buyerMax(buyer)} USDC` : undefined
  const chosenAccount = accounts.find(a => a.id === account)

  const saveAccount = async () => {
    if (!user?.id) return
    const details = form.method === 'UPI' ? { upi_id: (form.f.upi_id || '').trim() } : { account: (form.f.account || '').trim(), ifsc: (form.f.ifsc || '').trim().toUpperCase(), bank: (form.f.bank || '').trim() }
    if (form.method === 'UPI' ? !/^[\w.-]{2,}@[\w.-]{2,}$/.test(details.upi_id!) : !(details.account && details.ifsc)) { toast(form.method === 'UPI' ? 'Enter a valid UPI ID' : 'Enter account number and IFSC', 'error'); return }
    setBusy(true)
    const { method, error } = await savePaymentMethod(user.id, { method: form.method === 'UPI' ? 'UPI' : 'Bank Transfer', holderName: form.holder, details })
    setBusy(false)
    if (!method) { toast(error || 'Could not save the account', 'error'); return }
    setAccounts(a => [...a, method]); setAccount(method.id); setAdding(false)
  }

  const confirm = () => {
    if (!buyer || !chosenAccount || !user?.id || !wallet || err || !value) return
    gate.ask('Confirm cash out', `Lock ${money(value)} in escrow for ${inr(value * buyer.offer.pricePerUsdc)}`, async code => {
      setBusy(true)
      try {
        await unlockKey(code)
        const t = await startCashOut({ buyer, userId: user.id, wallet, amountUsdc: value, account: chosenAccount })
        setAmount(''); setTradeId(t.id); load()
      } catch (e) { toast(e instanceof Error ? e.message : 'Could not start the cash out', 'error') }
      setBusy(false)
    })
  }

  return (
    <>
      <BusinessScreen open={open && !tradeId} title="Cash out to bank" onBack={onBack}
        footer={adding ? undefined : <PrimaryBtn disabled={busy || !buyer || !chosenAccount || !value || !!err} onClick={confirm}>
          {busy ? 'Starting…' : value && buyer ? `Sell ${money(value)} for ${inr(value * buyer.offer.pricePerUsdc)}` : 'Enter an amount'}</PrimaryBtn>}>
        <div className="flex flex-col gap-5 px-5 pt-5 pb-6">
          <CashOutHero usdc={money(arc)} estimate={rate ? `≈ ${inr(arc * rate)}` : '—'} rateLabel={best ? `Best rate ${inr(best.offer.pricePerUsdc)} / USDC` : 'Looking for buyers…'} />
          <CashOutAmount value={amount} onChange={v => setAmount(v.replace(/[^0-9.]/g, ''))} max={money(arc)}
            onMax={() => setAmount(String(Math.floor(Math.min(arc, buyer ? buyerMax(buyer) : arc) * 100) / 100))}
            estimate={value && rate ? `You get ≈ ${inr(value * rate)}` : ''} error={err} />
          <div>
            <p className="text-sm font-semibold text-text-primary mb-2">Choose a buyer</p>
            <BuyerOfferList loading={buyers === null} selected={selected} onSelect={setSelected}
              offers={(buyers ?? []).map((b, i) => ({
                id: b.offer.id, name: b.offer.displayName || (b.offer.username ? `${b.offer.username}.arc` : 'Buyer'), verified: b.offer.isVerifiedMerchant,
                rating: b.rating.count ? `${b.rating.avg.toFixed(1)} · ${b.rating.count} rating${b.rating.count === 1 ? '' : 's'}` : 'New buyer',
                price: inr(b.offer.pricePerUsdc), limits: `${inr(b.offer.minAmount * b.offer.pricePerUsdc)} – ${inr(buyerMax(b) * b.offer.pricePerUsdc)}`,
                methods: b.offer.paymentMethods, best: i === 0,
              }))} />
          </div>
          <div>
            <p className="text-sm font-semibold text-text-primary mb-2">Get paid to</p>
            {adding ? (
              <PayoutAccountForm method={form.method} onMethod={m => setForm(x => ({ ...x, method: m }))} holder={form.holder} onHolder={v => setForm(x => ({ ...x, holder: v }))}
                fields={form.method === 'UPI'
                  ? [{ key: 'upi_id', label: 'UPI ID', value: form.f.upi_id ?? '', placeholder: 'name@okaxis' }]
                  : [{ key: 'account', label: 'Account number', value: form.f.account ?? '', placeholder: '1234567890' },
                     { key: 'ifsc', label: 'IFSC', value: form.f.ifsc ?? '', placeholder: 'HDFC0001234' },
                     { key: 'bank', label: 'Bank', value: form.f.bank ?? '', placeholder: 'HDFC Bank' }]}
                onField={(k, v) => setForm(x => ({ ...x, f: { ...x.f, [k]: v } }))} busy={busy} onSave={saveAccount} onCancel={() => setAdding(false)} />
            ) : (
              <PayoutAccountPicker accounts={accounts.map(a => ({ id: a.id, method: a.method, summary: `${a.method} · ${paymentMethodSummary(a)}` }))}
                selected={account} onSelect={setAccount} onAdd={() => setAdding(true)} />
            )}
          </div>
          <CashOutHistory items={trades.map(t => ({ id: t.id, amountUsdc: money(t.amountUsdc), amountFiat: inr(t.amountFiat), buyer: 'Buyer',
            when: t.createdAt, status: historyStatus(t) }))} onOpen={setTradeId} />
        </div>
      </BusinessScreen>
      <CashOutTradeScreen tradeId={open ? tradeId : null} accounts={accounts} onBack={() => { setTradeId(null); load() }} gate={gate} />
      {gate.sheet}
    </>
  )
}

function CashOutTradeScreen({ tradeId, accounts, onBack, gate }: {
  tradeId: string | null; accounts: P2PPaymentMethod[]; onBack: () => void; gate: ReturnType<typeof usePasscodeGate>
}) {
  const toast = useUIStore(s => s.showToastMessage)
  const user = useAuthStore(s => s.user)
  const [trade, setTrade] = useState<P2PTrade | null>(null)
  const [messages, setMessages] = useState<P2PMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<string>()
  const [now, setNow] = useState(Date.now())
  const seen = useRef(new Set<string>())

  const [loadError, setLoadError] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    setTrade(null); setMessages([]); setLoadError(false); seen.current = new Set()
    if (!tradeId) return
    let live = true
    fetchTrade(tradeId).then(t => { if (!live) return; if (t) setTrade(t); else setLoadError(true) }).catch(() => { if (live) setLoadError(true) })
    fetchTradeMessages(tradeId).then(m => { if (!live) return; m.forEach(x => seen.current.add(x.id)); setMessages(m) }).catch(() => {})
    const a = subscribeToTradeUpdates(tradeId, t => { if (live) setTrade(t) })
    const b = subscribeToTradeMessages(tradeId, m => { if (!live || seen.current.has(m.id)) return; seen.current.add(m.id); setMessages(x => [...x, m]) })
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => { live = false; a(); b(); clearInterval(t) }
  }, [tradeId, attempt])

  const act = async (name: string, fn: () => Promise<{ success: boolean; message: string }>) => {
    setBusy(name)
    const r = await fn().catch(e => ({ success: false, message: e instanceof Error ? e.message : 'Failed' }))
    toast(r.message, r.success ? 'success' : 'error')
    if (tradeId) fetchTrade(tradeId).then(t => { if (t) setTrade(t) }).catch(() => {})
    setBusy(undefined)
  }

  const stage: TradeStage = !trade ? 'escrow' : trade.disputeStatus === 'open' ? 'disputed' : STAGE[trade.status]
  const left = trade ? Date.parse(trade.expiresAt) - now : 0
  const acct = trade && accounts.find(a => a.id === trade.paymentMethodId)

  return (
    <BusinessScreen open={!!tradeId} title="Cash out" onBack={onBack}>
      <div className="px-5 pt-5 pb-6">
        {!trade && loadError ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="text-sm text-text-secondary">Could not load this cash out.</p>
            <PrimaryBtn onClick={() => setAttempt(n => n + 1)}>Try again</PrimaryBtn>
          </div>
        ) : !trade ? <Skeleton className="h-64 w-full" /> : (
          <CashOutTradeView amountUsdc={money(trade.amountUsdc)} amountFiat={inr(trade.amountFiat)} buyer="Buyer" stage={stage}
            deadline={stage === 'waiting_payment' && left > 0 ? `Buyer pays within ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}` : undefined}
            account={acct ? `${acct.method} · ${paymentMethodSummary(acct)}` : trade.paymentMethod}
            messages={messages.map(m => ({ id: m.id, mine: m.senderId === user?.id, system: m.isSystem, text: m.content,
              time: new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }))}
            draft={draft} onDraft={setDraft}
            onSend={async () => { if (!draft.trim() || !user?.id || !tradeId) return; const t = draft.trim(); setDraft(''); await sendTradeMessage(tradeId, user.id, t) }}
            onRelease={() => gate.ask('Release USDC', `Only if ${inr(trade.amountFiat)} is in your account`, () => act('release', () => releaseTrade(trade)))}
            onCancel={() => {
              const can = user?.id ? canCancelTrade(trade, user.id) : { allowed: false, reason: '' }
              if (!can.allowed) { toast(can.reason || 'This cash out cannot be cancelled now', 'error'); return }
              void act('cancel', () => cancelTrade(trade, 'Cancelled by seller', user!.id))
            }}
            onDispute={() => user?.id && act('dispute', () => openDispute(trade, user.id, 'Buyer marked paid but the money did not arrive'))}
            busy={busy} />
        )}
      </div>
    </BusinessScreen>
  )
}

// ── Stores & outlets ─────────────────────────────────────────────────────

const STORE_TYPES: string[] = [...BUSINESS_CATEGORIES]

type Editing = { title: string; back: () => void } | null

function StoresBody({ open, onEditing, onChanged, onQr, paymentsByStore, addLockedNote }: {
  addLockedNote?: string
  open: boolean; onEditing: (e: Editing) => void; onChanged: (stores: Store[]) => void; onQr: (id: string) => void
  paymentsByStore: Map<string, { total: number; count: number }>
}) {
  const toast = useUIStore(s => s.showToastMessage)
  const [stores, setStores] = useState<Store[] | null>(null)
  const [edit, setEdit] = useState<{ id?: string; name: string; type: string; address: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const load = () => listStores().then(s => { setStores(s); onChanged(s) }).catch(() => setStores([]))
  useEffect(() => { if (open) void load(); else setEdit(null) }, [open])
  useEffect(() => { onEditing(edit ? { title: edit.id ? 'Edit store' : 'New store', back: () => setEdit(null) } : null) }, [!!edit, edit?.id])

  const save = async () => {
    if (!edit) return
    setBusy(true)
    try { await saveStore({ ...edit, isDefault: !edit.id && !(stores ?? []).length ? true : undefined }); setEdit(null); await load() }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not save', 'error') }
    setBusy(false)
  }
  const remove = async () => {
    if (!edit?.id) return
    setBusy(true)
    try { await deleteStore(edit.id); setEdit(null); await load() } catch (e) { toast(e instanceof Error ? e.message : 'Could not delete', 'error') }
    setBusy(false)
  }

  return (
      <div className="px-5 pt-4 pb-6">
        {edit ? (
          <StoreForm name={edit.name} onName={v => setEdit({ ...edit, name: v })} type={edit.type} types={STORE_TYPES} onType={v => setEdit({ ...edit, type: v })}
            address={edit.address} onAddress={v => setEdit({ ...edit, address: v })} busy={busy} onSave={save}
            onDelete={edit.id ? remove : undefined} onCancel={() => setEdit(null)} />
        ) : stores === null ? <Skeleton className="h-40 w-full" /> : (
          <StoresView stores={stores.map(s => {
            const p = paymentsByStore.get(s.id)
            return { id: s.id, name: s.name, type: s.type ?? 'Store', address: s.address ?? undefined, isDefault: s.isDefault,
              payments: p ? `${money(p.total)} · ${p.count} payment${p.count === 1 ? '' : 's'}` : 'No payments yet' }
          })}
            onAdd={() => setEdit({ name: '', type: STORE_TYPES[0], address: '' })}
            onEdit={id => { const s = stores.find(x => x.id === id); if (s) setEdit({ id, name: s.name, type: s.type ?? STORE_TYPES[0], address: s.address ?? '' }) }}
            onQr={onQr} addLockedNote={addLockedNote} />
        )}
      </div>
  )
}

// ── Staff & roles ────────────────────────────────────────────────────────

function StaffBody({ open, onEditing, stores }: { open: boolean; onEditing: (e: Editing) => void; stores: Store[] }) {
  const terms = useBizTerms()
  const toast = useUIStore(s => s.showToastMessage)
  const [staff, setStaff] = useState<StaffMember[] | null>(null)
  const [edit, setEdit] = useState<{ id?: string; username: string; role: StaffRole; store: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const load = () => listStaff().then(setStaff).catch(() => setStaff([]))
  useEffect(() => { if (open) void load(); else setEdit(null) }, [open])
  useEffect(() => { onEditing(edit ? { title: edit.id ? 'Edit staff' : 'Invite staff', back: () => setEdit(null) } : null) }, [!!edit, edit?.id])
  const storeName = useMemo(() => new Map(stores.map(s => [s.id, s.name])), [stores])

  const save = async () => {
    if (!edit) return
    setBusy(true); setError(undefined)
    try {
      if (edit.id) await updateStaff(edit.id, edit.role, edit.store || null)
      else await inviteStaff(edit.username, edit.role, edit.store || null)
      toast(edit.id ? 'Saved' : 'Invite sent', 'success'); setEdit(null); await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save') }
    setBusy(false)
  }

  return (
      <div className="px-5 pt-4 pb-6">
        {edit ? (
          <StaffForm username={edit.username} onUsername={v => setEdit({ ...edit, username: v })} role={edit.role} onRole={r => setEdit({ ...edit, role: r })}
            stores={[{ id: '', name: `All ${terms.stores.toLowerCase()}` }, ...stores.map(s => ({ id: s.id, name: s.name }))]} store={edit.store} onStore={v => setEdit({ ...edit, store: v })}
            busy={busy} error={error} onSave={save} onCancel={() => setEdit(null)} />
        ) : staff === null ? <Skeleton className="h-40 w-full" /> : (
          <StaffView staff={staff.map(m => ({ id: m.id, name: `${m.username}.arc`, role: m.role, status: m.status, store: m.storeId ? storeName.get(m.storeId) : undefined }))}
            onInvite={() => { setError(undefined); setEdit({ username: '', role: 'cashier', store: '' }) }}
            onEdit={id => { const m = staff.find(x => x.id === id); if (m) { setError(undefined); setEdit({ id, username: m.username, role: m.role, store: m.storeId ?? '' }) } }}
            onRemove={async id => { try { await removeStaff(id); await load() } catch (e) { toast(e instanceof Error ? e.message : 'Could not remove', 'error') } }} />
        )}
      </div>
  )
}

// ── Stores & staff (one screen) ──────────────────────────────────────────

export function TeamScreen({ open, onBack, stores, onChanged, onQr, paymentsByStore, canAddStores = true }: {
  /** Stores are opened once the business is approved */
  canAddStores?: boolean
  open: boolean; onBack: () => void; stores: Store[]; onChanged: (stores: Store[]) => void; onQr: (id: string) => void
  paymentsByStore: Map<string, { total: number; count: number }>
}) {
  const terms = useBizTerms()
  const [view, setView] = useState<'stores' | 'staff'>('stores')
  const [editing, setEditing] = useState<Editing>(null)
  useEffect(() => { if (!open) { setView('stores'); setEditing(null) } }, [open])
  return (
    <BusinessScreen open={open} title={editing?.title ?? `${terms.stores} & staff`} onBack={editing?.back ?? onBack}>
      {!editing && (
        <div className="px-5 pt-4">
          <div className="flex p-1 rounded-2xl bg-surface border border-border" role="tablist" aria-label="Stores or staff">
            {([['stores', terms.stores], ['staff', 'Staff']] as const).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}
                className={`flex-1 min-h-[40px] rounded-xl text-sm font-semibold transition-colors ${view === id ? 'bg-card text-text-primary shadow-sm' : 'text-text-muted'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {view === 'stores'
        ? <StoresBody open={open} onEditing={setEditing} onChanged={onChanged} onQr={onQr} paymentsByStore={paymentsByStore}
            addLockedNote={canAddStores ? undefined : 'You can add stores once your business is approved'} />
        : <StaffBody open={open} onEditing={setEditing} stores={stores} />}
    </BusinessScreen>
  )
}

