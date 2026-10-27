// Business → Cash out: dollars to the merchant's UPI or bank in rupees.
// One screen (amount → rupees, the best buyer picked, the account), then a
// tracker that shows where the money is. Money and data from
// lib/businessCashOut (P2P marketplace + escrow): the USDC is locked in
// escrow, the buyer pays rupees, and the merchant releases only after the
// rupees arrive.
import { useEffect, useMemo, useRef, useState } from 'react'
import { History, MessageCircle, ShieldCheck, ChevronRight } from 'lucide-react'
import { useAuthStore, useUIStore, useWalletStore } from '@/store'
import {
  listBuyers, buyerMax, startCashOut, listCashOuts, fetchTrade, releaseTrade, cancelTrade, canCancelTrade, openDispute,
  fetchMyPaymentMethods, savePaymentMethod, fetchTradeMessages, sendTradeMessage, subscribeToTradeMessages, subscribeToTradeUpdates,
  paymentMethodSummary, fetchCounterpartyProfiles, inr, type BuyerOffer, type P2PTrade, type P2PPaymentMethod, type P2PMessage,
} from '@/lib/businessCashOut'
import { refreshBalancesAfterTx } from '@/lib/balanceRefresh'
import { AmountKeypad, sanitizeAmountInput } from '@/components/ui/AmountKeypad'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DESKTOP_QUERY } from '@/lib/motion'
import {
  BusinessScreen, ScreenLevel, useScreenLevel, Sheet, PrimaryBtn, GhostBtn, Skeleton,
  CashOutAmountCard, CashOutPickRow, BuyerList, PayoutAccountList, PayoutAccountForm, CashOutTracker, CashOutChat, CashOutHistoryList,
  type PayoutMethod, type TradeStage, type CashOutHistoryStatus,
} from './ui'
import { unlockSigner } from './settlement'
import { usePasscodeGate } from './passcodeGate'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const short = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
const clock = (iso?: string) => iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
// A rate always shows paise: ₹83.40, not ₹83.4.
const rateText = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / $`
const buyerName = (b: BuyerOffer) => b.offer.displayName || (b.offer.username ? `${b.offer.username}.arc` : 'Buyer')
const fits = (b: BuyerOffer, v: number) => v >= b.offer.minAmount && v <= buyerMax(b)

const STAGE: Record<P2PTrade['status'], TradeStage> = {
  awaiting_seller_confirmation: 'escrow', waiting_for_buyer: 'waiting_payment', payment_sent: 'payment_sent',
  released: 'released', completed: 'released', cancelled: 'cancelled', expired: 'cancelled',
}
const stageOf = (t: P2PTrade): TradeStage => t.disputeStatus === 'open' ? 'disputed' : STAGE[t.status]
const historyStatus = (t: P2PTrade): CashOutHistoryStatus => {
  const s = stageOf(t)
  return s === 'disputed' ? 'disputed' : s === 'released' ? 'completed' : s === 'cancelled' ? 'cancelled' : s === 'payment_sent' ? 'action' : 'active'
}

export function CashOutScreen({ open, onBack }: { open: boolean; onBack: () => void }) {
  const toast = useUIStore(s => s.showToastMessage)
  const user = useAuthStore(s => s.user)
  const wallet = useAuthStore(s => s.walletAddress)
  const arc = Number(useWalletStore(s => s.balance)) || 0
  const gate = usePasscodeGate()
  const [buyers, setBuyers] = useState<BuyerOffer[] | null>(null)
  const [picked, setPicked] = useState<string>()
  const [amount, setAmount] = useState('')
  const [accounts, setAccounts] = useState<P2PPaymentMethod[] | null>(null)
  const [account, setAccount] = useState<string>()
  const [sheet, setSheet] = useState<'buyer' | 'account' | 'add' | null>(null)
  const [form, setForm] = useState<{ method: PayoutMethod; holder: string; f: Record<string, string> }>({ method: 'UPI', holder: '', f: {} })
  const [busy, setBusy] = useState(false)
  const [trades, setTrades] = useState<P2PTrade[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [tradeId, setTradeId] = useState<string | null>(null)
  const [view, setView] = useState<'main' | 'history'>('main')

  const load = () => {
    if (!user?.id) return
    listBuyers(user.id).then(setBuyers).catch(() => setBuyers([]))
    fetchMyPaymentMethods(user.id).then(a => { setAccounts(a); setAccount(x => x ?? a[0]?.id) }).catch(() => setAccounts([]))
    listCashOuts(user.id).then(t => {
      setTrades(t)
      fetchCounterpartyProfiles(t, user.id).then(m => setNames(new Map([...m].map(([id, p]) => [id, p.displayName || (p.username ? `${p.username}.arc` : 'Buyer')])))).catch(() => {})
    }).catch(() => {})
  }
  useEffect(() => { if (open) { setView('main'); load() } }, [open, user?.id])

  const value = Number(amount) || 0
  // The buyer: the one picked, else the best rate that can take this amount.
  const auto = buyers?.find(b => !value || fits(b, value)) ?? buyers?.[0]
  const buyer = buyers?.find(b => b.offer.id === picked) ?? auto
  const rate = buyer?.offer.pricePerUsdc ?? 0
  const err = !value ? undefined : value > arc ? `More than your balance (${money(arc)})`
    : buyer && value < buyer.offer.minAmount ? `${buyerName(buyer)} takes at least ${short(buyer.offer.minAmount)}`
    : buyer && value > buyerMax(buyer) ? `${buyerName(buyer)} takes up to ${short(buyerMax(buyer))}` : undefined
  const chosenAccount = accounts?.find(a => a.id === account)
  const maxOut = Math.floor(Math.min(arc, Math.max(0, ...(buyers ?? []).map(buyerMax))) * 100) / 100
  const setAmt = (v: string) => setAmount(sanitizeAmountInput(v, 2).slice(0, 10))
  const quick = [100, 500, 1000].map(n => ({ label: short(n), onClick: () => setAmt(String(n)), disabled: n > maxOut + 1e-9 }))
  // Phone: the amount is entered on the app's AmountKeypad sheet.
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  const [padOpen, setPadOpen] = useState(false)
  useEffect(() => { if (!open) setPadOpen(false) }, [open])
  const active = trades.filter(t => ['escrow', 'waiting_payment', 'payment_sent', 'disputed'].includes(stageOf(t)))

  const saveAccount = async () => {
    if (!user?.id) return
    const details = form.method === 'UPI' ? { upi_id: (form.f.upi_id || '').trim() } : { account: (form.f.account || '').trim(), ifsc: (form.f.ifsc || '').trim().toUpperCase(), bank: (form.f.bank || '').trim() }
    if (form.method === 'UPI' ? !/^[\w.-]{2,}@[\w.-]{2,}$/.test(details.upi_id!) : !(details.account && details.ifsc)) { toast(form.method === 'UPI' ? 'Enter a valid UPI ID, like name@okaxis' : 'Enter the account number and IFSC', 'error'); return }
    if (!form.holder.trim()) { toast('Enter the name on the account', 'error'); return }
    setBusy(true)
    const { method, error } = await savePaymentMethod(user.id, { method: form.method === 'UPI' ? 'UPI' : 'Bank Transfer', holderName: form.holder.trim(), details })
    setBusy(false)
    if (!method) { toast(error || 'Could not save the account', 'error'); return }
    setAccounts(a => [...(a ?? []), method]); setAccount(method.id); setSheet(null); setForm({ method: 'UPI', holder: '', f: {} })
  }

  const confirm = () => {
    if (!buyer || !user?.id || !wallet || err || !value) return
    if (!chosenAccount) { setSheet(accounts?.length ? 'account' : 'add'); return }
    gate.ask('Confirm cash out', `Lock ${money(value)} for ${inr(value * buyer.offer.pricePerUsdc)} to ${paymentMethodSummary(chosenAccount)}`, async code => {
      setBusy(true)
      try {
        await unlockSigner(code)
        const t = await startCashOut({ buyer, userId: user.id, wallet, amountUsdc: value, account: chosenAccount })
        refreshBalancesAfterTx(wallet, { spent: value })
        setNames(m => new Map(m).set(t.buyerId, buyerName(buyer)))
        setAmount(''); setPicked(undefined); setTradeId(t.id); load()
      } catch (e) { toast(e instanceof Error ? e.message : 'Could not start the cash out', 'error') }
      setBusy(false)
    })
  }

  const monthTotal = useMemo(() => {
    const m = new Date().toISOString().slice(0, 7)
    const done = trades.filter(t => historyStatus(t) === 'completed' && t.createdAt.slice(0, 7) === m)
    return { fiat: done.reduce((s, t) => s + t.amountFiat, 0), count: done.length }
  }, [trades])

  // The tracker pushes over this screen (which shifts left beneath it), and
  // back uncovers it - like any screen opened from another.
  const { level, covered } = useScreenLevel()
  // "UPI · sunil@okaxis": the holder's name goes on the line below.
  const accountLabel = (a: P2PPaymentMethod) => `${a.method === 'Bank Transfer' ? 'Bank' : a.method} · ${paymentMethodSummary({ ...a, holderName: '' })}`

  return (
    <>
      <ScreenLevel.Provider value={{ level, covered: covered || !!tradeId }}>
      {view === 'history' ? (
        <BusinessScreen open={open} title="Cash out history" onBack={() => setView('main')} step="history">
          <div className="flex flex-col gap-4 px-5 pt-5 pb-6">
            {trades.length > 0 && (
              <div className="rounded-2xl bg-card soft-card p-4 flex items-end justify-between gap-3">
                <div><p className="text-xs text-text-muted">Cashed out this month</p><p className="text-[22px] font-bold tabular-nums text-text-primary">{inr(monthTotal.fiat)}</p></div>
                <p className="text-xs text-text-muted">{monthTotal.count} cash out{monthTotal.count === 1 ? '' : 's'}</p>
              </div>
            )}
            <CashOutHistoryList onOpen={setTradeId} items={trades.map(t => ({
              id: t.id, amountFiat: inr(t.amountFiat), status: historyStatus(t),
              detail: [short(t.amountUsdc), names.get(t.buyerId), day(t.createdAt)].filter(Boolean).join(' · '),
            }))} />
            <p className="text-xs text-text-muted text-center">Each cash out is also in Activity.</p>
          </div>
        </BusinessScreen>
      ) : (
        <BusinessScreen open={open} title="Cash out" onBack={onBack}
          action={<button type="button" onClick={() => setView('history')} className="min-h-[36px] px-2 inline-flex items-center gap-1 text-[13px] font-semibold text-brand-text"><History className="size-4" /> History</button>}
          footer={<PrimaryBtn disabled={busy || !buyer || !value || !!err} onClick={confirm}>
            {busy ? 'Starting…' : !buyers?.length ? 'No buyers right now' : value && buyer && !err ? `Cash out ${inr(value * rate)}` : 'Enter an amount'}
          </PrimaryBtn>}>
          <div className="flex flex-col gap-4 px-5 pt-5 pb-6">
            {active.map(t => (
              <button key={t.id} type="button" onClick={() => setTradeId(t.id)}
                className={`flex items-center gap-3 rounded-2xl border p-3.5 text-left ${historyStatus(t) === 'action' ? 'bg-warning/10 border-warning/30' : 'bg-card border-border'}`}>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] font-semibold text-text-primary">{historyStatus(t) === 'action' ? `Check your bank for ${inr(t.amountFiat)}` : `Cash out of ${inr(t.amountFiat)} in progress`}</span>
                  <span className="block text-xs text-text-muted truncate">{short(t.amountUsdc)}{names.get(t.buyerId) ? ` · ${names.get(t.buyerId)}` : ''} · tap to see where it's up to</span>
                </span>
                <ChevronRight className="size-4 text-text-muted shrink-0" />
              </button>
            ))}
            {/* Dollars and cents (Max is floored to cents too). */}
            <CashOutAmountCard value={amount} onChange={setAmt}
              available={money(arc)} quick={quick} onMax={maxOut > 0 ? () => setAmt(String(maxOut)) : undefined} error={err}
              onTap={isDesktop ? undefined : () => { (document.activeElement as HTMLElement | null)?.blur?.(); setPadOpen(true) }} editing={padOpen}
              fiat={value && rate ? inr(Math.round(value * rate * 100) / 100) : ''} rate={rate ? rateText(rate) : undefined} />
            <div className="rounded-2xl bg-card border border-border divide-y divide-border overflow-hidden">
              <CashOutPickRow icon="buyer" loading={buyers === null} onClick={() => buyers?.length && setSheet('buyer')}
                title={buyer ? buyerName(buyer) : 'No buyers right now'}
                subtitle={buyer ? [buyer === auto && !picked ? 'Best rate' : rateText(buyer.offer.pricePerUsdc), buyer.rating.count ? `★ ${buyer.rating.avg.toFixed(1)} · ${buyer.rating.count} trade${buyer.rating.count === 1 ? '' : 's'}` : 'New buyer'].join(' · ') : 'Buyers are usually around in business hours'}
                action={buyers && buyers.length > 1 ? 'Change' : undefined} />
              <CashOutPickRow icon="bank" loading={accounts === null} onClick={() => setSheet(accounts?.length ? 'account' : 'add')}
                title={chosenAccount ? accountLabel(chosenAccount) : 'Add your UPI or bank'}
                subtitle={chosenAccount ? (chosenAccount.holderName || 'Get paid here') : 'Where the buyer sends the rupees'} />
            </div>
            <div className="flex gap-2.5 rounded-2xl bg-card border border-border p-3.5 text-xs text-text-secondary">
              <ShieldCheck className="size-4 text-brand-text shrink-0" /> Your dollars stay locked until you see the rupees in your bank. You release them, never before.
            </div>
          </div>
        </BusinessScreen>
      )}
      </ScreenLevel.Provider>
      <ScreenLevel.Provider value={{ level: level + 1, covered }}>
        <CashOutTradeScreen tradeId={open ? tradeId : null} accounts={accounts ?? []} buyerNames={names} onBack={() => { setTradeId(null); load() }} gate={gate} />
      </ScreenLevel.Provider>

      {/* Phone: the app's amount keypad for the Cash out amount. */}
      {!isDesktop && (
        <AmountKeypad open={open && padOpen && !tradeId} value={amount} onChange={setAmt} balance={maxOut} token="USDC"
          decimals={2} showMax={false} error={err} onClose={() => setPadOpen(false)} />
      )}

      <Sheet open={sheet === 'buyer'} onClose={() => setSheet(null)} id="cashout-buyer">
        <div className="flex flex-col pb-5 min-h-0">
          <p className="px-5 pt-1 pb-3 text-base font-semibold text-text-primary">Choose a buyer{value ? ` for ${short(value)}` : ''}</p>
          <div className="overflow-y-auto">
            <BuyerList selected={buyer?.offer.id} onSelect={id => { setPicked(id); setSheet(null) }} buyers={(buyers ?? []).map((b, i) => ({
              id: b.offer.id, name: buyerName(b), verified: b.offer.isVerifiedMerchant, best: i === 0,
              detail: [b.rating.count ? `★ ${b.rating.avg.toFixed(1)}` : 'New buyer', b.offer.paymentMethods.join(', ')].filter(Boolean).join(' · '),
              note: value && !fits(b, value) ? `Takes ${short(b.offer.minAmount)} – ${short(buyerMax(b))}` : undefined,
              youGet: value && fits(b, value) ? inr(Math.round(value * b.offer.pricePerUsdc * 100) / 100) : '',
              rate: rateText(b.offer.pricePerUsdc), disabled: !!value && !fits(b, value),
            }))} />
          </div>
        </div>
      </Sheet>
      <Sheet open={sheet === 'account' || sheet === 'add'} onClose={() => setSheet(null)} id="cashout-account">
        <div className="flex flex-col pb-5 min-h-0 overflow-y-auto">
          <p className="px-5 pt-1 pb-3 text-base font-semibold text-text-primary">{sheet === 'add' ? 'Add UPI or bank account' : 'Get paid to'}</p>
          {sheet === 'add' ? (
            <PayoutAccountForm method={form.method} onMethod={m => setForm(x => ({ ...x, method: m }))} holder={form.holder} onHolder={v => setForm(x => ({ ...x, holder: v }))}
              fields={form.method === 'UPI'
                ? [{ key: 'upi_id', label: 'UPI ID', value: form.f.upi_id ?? '', placeholder: 'name@okaxis' }]
                : [{ key: 'account', label: 'Account number', value: form.f.account ?? '', placeholder: '1234567890' },
                   { key: 'ifsc', label: 'IFSC', value: form.f.ifsc ?? '', placeholder: 'HDFC0001234' },
                   { key: 'bank', label: 'Bank', value: form.f.bank ?? '', placeholder: 'HDFC Bank' }]}
              onField={(k, v) => setForm(x => ({ ...x, f: { ...x.f, [k]: v } }))} busy={busy} onSave={saveAccount}
              onCancel={() => setSheet(accounts?.length ? 'account' : null)} />
          ) : (
            <PayoutAccountList selected={account} onSelect={id => { setAccount(id); setSheet(null) }} onAdd={() => setSheet('add')}
              accounts={(accounts ?? []).map(a => ({ id: a.id, method: a.method, summary: accountLabel(a), holder: a.holderName }))} />
          )}
        </div>
      </Sheet>
      {gate.sheet}
    </>
  )
}

function CashOutTradeScreen({ tradeId, accounts, buyerNames, onBack, gate }: {
  tradeId: string | null; accounts: P2PPaymentMethod[]; buyerNames: Map<string, string>; onBack: () => void; gate: ReturnType<typeof usePasscodeGate>
}) {
  const toast = useUIStore(s => s.showToastMessage)
  const user = useAuthStore(s => s.user)
  const [trade, setTrade] = useState<P2PTrade | null>(null)
  const [messages, setMessages] = useState<P2PMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<string>()
  const [now, setNow] = useState(Date.now())
  const [chat, setChat] = useState(false)
  const [buyer, setBuyer] = useState<string>()
  const seen = useRef(new Set<string>())
  const [loadError, setLoadError] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    setTrade(null); setMessages([]); setLoadError(false); setChat(false); setBuyer(undefined); seen.current = new Set()
    if (!tradeId) return
    let live = true
    fetchTrade(tradeId).then(t => {
      if (!live) return
      if (!t) { setLoadError(true); return }
      setTrade(t)
      if (!buyerNames.get(t.buyerId) && user?.id) fetchCounterpartyProfiles([t], user.id).then(m => {
        const p = m.get(t.buyerId); if (live && p) setBuyer(p.displayName || (p.username ? `${p.username}.arc` : undefined))
      }).catch(() => {})
    }).catch(() => { if (live) setLoadError(true) })
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

  const stage: TradeStage = trade ? stageOf(trade) : 'escrow'
  const left = trade ? Date.parse(trade.expiresAt) - now : 0
  const acct = trade && accounts.find(a => a.id === trade.paymentMethodId)
  const name = (trade && buyerNames.get(trade.buyerId)) || buyer || 'The buyer'
  const unread = messages.filter(m => !m.isSystem && m.senderId !== user?.id).length

  const cancel = () => {
    if (!trade || !user?.id) return
    const can = canCancelTrade(trade, user.id)
    if (!can.allowed) { toast(can.reason || 'This cash out cannot be cancelled now', 'error'); return }
    void act('cancel', () => cancelTrade(trade, 'Cancelled by seller', user.id))
  }
  const footer = !trade ? undefined
    : stage === 'payment_sent' ? (
      <div className="flex flex-col gap-2">
        <PrimaryBtn disabled={!!busy} onClick={() => gate.ask('Release dollars', `Only if ${inr(trade.amountFiat)} is in your bank`, () => act('release', () => releaseTrade(trade)))}>
          {busy === 'release' ? 'Releasing…' : `I got ${inr(trade.amountFiat)} · Release`}
        </PrimaryBtn>
        <GhostBtn disabled={!!busy} onClick={() => user?.id && act('dispute', () => openDispute(trade, user.id, 'Buyer marked paid but the money did not arrive'))}>Not received? Get help</GhostBtn>
      </div>)
    : stage === 'escrow' || stage === 'waiting_payment' ? <GhostBtn disabled={!!busy} onClick={cancel}>{busy === 'cancel' ? 'Cancelling…' : 'Cancel cash out'}</GhostBtn>
    : <PrimaryBtn onClick={onBack}>Done</PrimaryBtn>

  return (
    <>
      <BusinessScreen open={!!tradeId} title="Cash out" onBack={onBack} footer={footer}
        action={trade ? <button type="button" onClick={() => setChat(true)} className="min-h-[36px] px-2 inline-flex items-center gap-1 text-[13px] font-semibold text-brand-text">
          <MessageCircle className="size-4" /> Chat{unread ? ` · ${unread}` : ''}</button> : undefined}>
        <div className="px-5 pt-4 pb-6">
          {!trade && loadError ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-sm text-text-secondary">Could not load this cash out.</p>
              <PrimaryBtn onClick={() => setAttempt(n => n + 1)}>Try again</PrimaryBtn>
            </div>
          ) : !trade ? <Skeleton className="h-72 w-full rounded-2xl" /> : (
            <CashOutTracker amountUsdc={money(trade.amountUsdc)} amountFiat={inr(trade.amountFiat)} buyer={name} stage={stage}
              account={acct ? paymentMethodSummary({ ...acct, holderName: '' }) : trade.paymentMethod}
              lockedAt={clock(trade.createdAt)} paidAt={clock(trade.paymentSentAt)} cancelReason={trade.cancelReason}
              countdown={stage === 'waiting_payment' && left > 0 ? `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}` : undefined} />
          )}
        </div>
      </BusinessScreen>
      <Sheet open={chat} onClose={() => setChat(false)} height="full" id="cashout-chat">
        <CashOutChat onClose={() => setChat(false)} draft={draft} onDraft={setDraft}
          messages={messages.map(m => ({ id: m.id, mine: m.senderId === user?.id, system: m.isSystem, text: m.content, time: clock(m.createdAt) }))}
          onSend={async () => { if (!draft.trim() || !user?.id || !tradeId) return; const t = draft.trim(); setDraft(''); await sendTradeMessage(tradeId, user.id, t) }} />
      </Sheet>
    </>
  )
}
