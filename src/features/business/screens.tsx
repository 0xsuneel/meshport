// Business tab - its own screens. Every action on the Business tab opens one
// of these over the tab instead of sending the merchant to another page:
//
//   ShopQrScreen      the store's fixed QR (customer types the amount)
//   ReceiveScreen     Collect payment sheet: Shop QR · Request (the chat's Request
//                     form) · Bill (the chat's bill composer) -> one order shown
//                     as a counter QR and a link to send, live until it's paid
//   RequestsList      what the store asked to be paid (Payments → My requests)
//   ReportsScreen     Insights (the selected period by day, hour, customer and
//                     chain) and Statement (CSV / PDF), one screen
//   ProfileScreen     business details and approval (the application form)
//
// Visuals come from the Arc Studio kit in ./ui; this file holds the logic.
// Money in uses the merchant-pay service (payment requests, live status);
// nothing here moves funds out.
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { shopPayLink } from '@/lib/payLinks'
import { qrCardFile } from '@/lib/qrCardImage'
import { staffIntents } from '@/lib/businessTeam'
import { Store, Clock, Printer, Download, Share2 } from 'lucide-react'
import { useAuthStore, useUIStore } from '@/store'
import { useMerchant, useBusinessTab, applyForMerchant, setBusinessName, type BusinessDoc } from '@/lib/merchant'
import { BusinessDocsField } from '@/features/merchant/BusinessDocsField'
import { BUSINESS_CATEGORIES, toCategory, useBizTerms, cap } from '@/lib/businessCategories'
import { useNavigate } from 'react-router-dom'
import { Avatar } from '@/components/ui/Avatar'
import { chainLogoSrc } from '@/lib/chainLogos'
import {
  createPaymentRequest, listMyIntents, cancelPayment, reopenOrder, completeOrder, paymentLink, billCardMessage, paymentRequestMessage,
  type MerchantIntent, type MerchantPayment, shopFrom } from '@/lib/merchantPay'
import { speakPayment } from '@/lib/voiceAlerts'
import { timeAgo, formatAmount } from '@/lib/utils'
import { listItems, rememberItems, deleteItem, type SavedItem } from '@/lib/businessItems'
import { getShopLimits, setShopLimits } from '@/lib/shop'
import { SearchField } from '@/components/ui/SearchField'
import { ActionSheet, SheetPerson, SheetLabel, SheetChips } from '@/components/ui/ActionSheet'
import { RequestAmountForm } from '@/features/merchant/RequestComposer'
import { StorePicker, BusinessTitle, type PickerStore } from '@/features/merchant/StorePicker'
import { RequestResult, money, OPEN, VALID_FOR, dueTone, useQr, useShare, LinkShare, useLiveRequest, type ValidFor } from '@/features/merchant/RequestResult'
import { BillComposer } from '@/features/merchant/InvoiceComposer'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { UserPicker, exactPick, pickerProblem, type PickedUser } from '@/components/ui/UserPicker'
import { useChatCardSender } from '@/hooks/useChatCardSender'
import type { DbUser } from '@/lib/supabase'
import {
  BusinessScreen, QrCard, QrInfoBox, Field, TextInput, ChipSelect,
  RequestRow, InsightsChart, RankList, ProfileStatusCard, DetailList, PrimaryBtn, GhostBtn, Skeleton,
  QrSticker, HourChart, StatTriple, StatementView, PrintableStatement, ReceiptCard, HelpView,
  type RequestStatus, type StatusCardTone, type StatementRange,
} from './ui'
import { usePrint } from './printArea'
import { salesByHour, hourLabel, statementRows, rangeLabel, rangeStart, exportPaymentsCsv } from './reports'
import type { MerchantRefund } from '@/lib/merchantRefunds'
import { groupRefunds, refundedSum, remainingAfter, isFullyRefunded, extraLeft, MIN_REFUND } from '@/lib/refundTotals'
import { submitPayment, displayOrderNumber, listUnmatchedDeposits, assignDeposit, type UnmatchedDeposit } from '@/lib/merchantPay'
import { chainLabel } from './settlement'
import { dueText, canRemindAt, remindBill, remindCustomer } from '@/lib/businessBills'
import { logBusiness, type ActivityAction } from '@/lib/businessActivity'
import { khataByCustomer, customerKey, isOutstanding, totalOutstanding } from '@/lib/businessKhata'
import { Sheet, ShareChannels } from './ui'

/** How Charge / Payment link / Bill create requests: the owner's own
 *  (createPaymentRequest, for the active store) or, in staff mode, one that
 *  pays the business they work for (staff_create_request). */
type RequestInput = Parameters<typeof createPaymentRequest>[0]
export const RequestMaker = createContext<{ create: (p: RequestInput) => Promise<MerchantIntent>; storeId: string | null; canBill: boolean; savedItems?: boolean
  /** Post the order's card into the chat with a named customer (the owner
   *  only - staff are other people, so their orders aren't sent as them). */
  chat?: boolean
  /** Activity log (staff mode writes to the owner's log). */
  log?: (action: ActivityAction, p?: { target?: string | null; amount?: number | null }) => void }>({
  create: createPaymentRequest, storeId: null, canBill: true, savedItems: true,
})
const defaultLog = (action: ActivityAction, p?: { target?: string | null; amount?: number | null }) => { void logBusiness(action, p) }
function useMakeRequest() {
  const m = useContext(RequestMaker)
  return (p: RequestInput) => m.create({ ...p, storeId: p.storeId ?? m.storeId })
}

const isExpired = (i: { expiresAt: string | null; status: string }) => !!i.expiresAt && Date.parse(i.expiresAt) < Date.now() && i.status !== 'paid'

// ── Shared logic ─────────────────────────────────────────────────────────

/** Share a payment link: copy, native share, WhatsApp, SMS, email. */
function ShareSheet({ open, onClose, title, url, text, subject }: { open: boolean; onClose: () => void; title: string; url: string; text: string; subject: string }) {
  return (
    <Sheet open={open} onClose={onClose}>
      <div className="flex flex-col gap-4 px-5 pt-2 pb-[calc(env(safe-area-inset-bottom,0px)+20px)]">
        <p className="text-base font-bold text-text-primary">{title}</p>
        <LinkShare url={url} text={text} subject={subject} />
      </div>
    </Sheet>
  )
}

function Done({ icon, top, amount, note, children }: { icon: React.ReactNode; top?: string; amount: number; note?: string | null; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center px-5 pt-6 gap-4">
      <span className="inline-flex items-center justify-center size-12 rounded-2xl bg-brand/10 text-brand-text">{icon}</span>
      <div>
        {top && <p className="text-sm text-text-muted">{top}</p>}
        <p className="display text-3xl font-bold tabular-nums text-text-primary">{money(amount)}</p>
        {note && <p className="text-sm text-text-secondary mt-1">{note}</p>}
      </div>
      {children}
    </div>
  )
}

// ── Shop QR ──────────────────────────────────────────────────────────────

/** The store's fixed QR: customers scan, type the amount and pay. */
function ShopQrBody({ active, storeName, outlet, handle, payTo }: { active: boolean; storeName: string; outlet?: string | null; handle: string; payTo?: string }) {
  // payTo: whose pay link (staff mode: the business owner's, never the staff's own).
  // The QR names the outlet (?store=) so each store's payments land in that
  // store; it changes as soon as the owner switches stores.
  const own = useAuthStore(s => s.username)
  const { storeId } = useContext(RequestMaker)
  const username = payTo ?? own
  // The same link (and QR) as Receive's QR for this store.
  const url = shopPayLink(username ?? '', storeId)
  const qr = useQr(active && username ? url : null)
  const sticker = usePrint()
  const sub = outlet ? `${outlet} · ${handle}` : handle
  const from = shopFrom(storeName, outlet)
  const toast = useUIStore(s => s.showToastMessage)
  const { copy, copied } = useShare()
  // Download / Share QR - the same as Home's and Receive's QR card.
  // Saves the QR card (the same card as on screen, light), not the bare code.
  const qrFile = async () => qr ? qrCardFile({ data: url, title: storeName, subtitle: sub, tag: 'USDC · any network', caption: 'Scan, type the amount and pay' },
    `meshport-shop-qr${outlet ? `-${outlet.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : ''}.png`) : null
  const downloadQr = async () => {
    const f = await qrFile(); if (!f) return
    const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  const shareQr = async () => {
    const f = await qrFile().catch(() => null); if (!f) return
    const text = `Pay ${from} on MeshPort - ${url}`
    try {
      if (navigator.canShare?.({ files: [f] })) { await navigator.share({ files: [f], title: from, text }); return }
      if (navigator.share) { await navigator.share({ title: from, text }); return }
    } catch (e: any) { if (e?.name === 'AbortError') return }
    try { await navigator.clipboard.writeText(text); toast('Copied to clipboard', 'success') } catch { toast('Could not share QR', 'error') }
  }
  return (
    <div className="flex flex-col items-center text-center px-5 pt-6 pb-6 gap-5">
      {/* The store and its pay link over the QR (tap the link to copy), like
          Receive's QR - in place of the name lines and the link box below. */}
      <QrCard dataUrl={qr} caption="Scan, type the amount and pay"
        top={<div className="w-full flex gap-2">
          <QrInfoBox label="Store" value={outlet || storeName} mono={false} />
          <QrInfoBox label="Pay link" value={copied ? 'Copied' : 'Tap to copy'} mono={false} onCopy={() => void copy(url)} copied={copied} />
        </div>} />
      <div className="w-full grid grid-cols-2 gap-2">
        <GhostBtn disabled={!qr} onClick={() => void downloadQr()}><span className="inline-flex items-center gap-2"><Download className="size-4" /> Download QR</span></GhostBtn>
        <GhostBtn disabled={!qr} onClick={() => void shareQr()}><span className="inline-flex items-center gap-2"><Share2 className="size-4" /> Share QR</span></GhostBtn>
      </div>
      <GhostBtn disabled={!qr} onClick={() => sticker.print(<QrSticker dataUrl={qr} storeName={outlet ? `${storeName} · ${outlet}` : storeName} handle={handle} />)}>
        <span className="inline-flex items-center gap-2"><Printer className="size-4" /> Print counter sticker</span>
      </GhostBtn>
      {sticker.portal}
    </div>
  )
}

/** Several stores: the store to switch to from a screen's title. */
export type ScreenStorePick = { stores: PickerStore[]; value: string; onChange: (id: string) => void; onManage?: () => void }

/** A phone screen's title as the business - its logo and name, with the
 *  store under it (tap to switch) or, with one store, `line` (its handle). */
function businessHeading(business: string, avatar: string | null | undefined, line: string, pick?: ScreenStorePick) {
  return pick && pick.stores.length > 1
    ? <StorePicker variant="title" business={business} avatar={avatar} stores={pick.stores} value={pick.value} onChange={pick.onChange} onManage={pick.onManage}
        hint="Sales, payments, requests and the QR show this store only" />
    : <BusinessTitle business={business} avatar={avatar} line={line} />
}

export function ShopQrScreen({ open, onBack, storeName, outlet, handle, payTo, storePick, avatar }: { open: boolean; onBack: () => void; storeName: string; outlet?: string | null; handle: string; payTo?: string; storePick?: ScreenStorePick; avatar?: string | null }) {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  return (
    <BusinessScreen open={open} title="Shop QR" onBack={onBack} heading={isDesktop ? undefined : businessHeading(storeName, avatar, handle, storePick)}>
      <ShopQrBody active={open} storeName={storeName} outlet={outlet} handle={handle} payTo={payTo} />
    </BusinessScreen>
  )
}

// ── Receive (counter QR + shareable link, one order) ─────────────────────

type CollectTab = 'qr' | 'charge' | 'bill'

/** "@Priya.arc " → "priya" (what the customer field holds). */
const cleanUsername = (v: string) => v.trim().replace(/^@/, '').replace(/\.arc$/i, '').toLowerCase()

/** Collect payment: a bottom sheet with Shop QR · Request · Bill. Request is
 *  the chat's Request form (RequestAmountForm) and Bill the chat's bill
 *  composer (BillComposer), so they look and work the same; the order they
 *  make then shows here as a counter QR and a link, live until it's paid.
 *  Without `shopQr` (staff mode) only Request (and Bill for managers). */
export function ReceiveScreen({ open, onBack, storeName, shopQr, onChanged, storePick, avatar }: {
  open: boolean; onBack: () => void; storeName: string
  /** The business's logo, in the phone's title. */
  avatar?: string | null
  shopQr?: { outlet?: string | null; handle: string }
  /** An order was created or cancelled here (refreshes open-order counts). */
  onChanged?: () => void
  /** Several stores: the store chip in the title row (phone), in place of
   *  the "Paid to" block - the card / form already says who's paid. */
  storePick?: ScreenStorePick
}) {
  const t = useBizTerms()
  const isDesktop = useMediaQuery('(min-width: 980px)')
  // Business owners hear payments from PaymentReceivedWatcher (every screen).
  const owner = useBusinessTab()
  const make = useMakeRequest()
  const toast = useUIStore(s => s.showToastMessage)
  // Cashiers take counter payments only: up to an hour, no named customer, no bills.
  const { canBill, savedItems = true, log = defaultLog, chat = false } = useContext(RequestMaker)
  const navigate = useNavigate()
  const validFor: readonly { id: ValidFor; label: string }[] = canBill ? VALID_FOR : VALID_FOR.slice(0, 2)
  const [tab, setTab] = useState<CollectTab>(shopQr ? 'qr' : 'charge')
  // The customer: searched like Pay's recipients, picked as a chip. Only a
  // real MeshPort user can be named on an order.
  const [customerQuery, setCustomerQuery] = useState('')
  const [picked, setPicked] = useState<PickedUser | null>(null)
  const [found, setFound] = useState<{ results: DbUser[]; searching: boolean }>({ results: [], searching: false })
  // With a named customer the order's card is posted into your chat with them.
  const sender = useChatCardSender()
  const [expiry, setExpiry] = useState<ValidFor>('15')
  // The owner's saved items (products and prices), tapped into a bill.
  const [catalog, setCatalog] = useState<SavedItem[]>([])
  useEffect(() => { if (open && savedItems && canBill) listItems().then(setCatalog).catch(() => {}) }, [open, savedItems, canBill])
  const removeSaved = async (it: SavedItem) => {
    setCatalog(c => c.filter(x => x.id !== it.id))
    await deleteItem(it.id).catch(() => toast('Could not remove', 'error'))
  }
  const [intent, setIntent] = useState<MerchantIntent | null>(null)
  const view = useLiveRequest(intent?.code ?? null)
  const paid = view?.status === 'paid'

  useEffect(() => { if (paid && !owner) speakPayment(view!.received) }, [paid])
  const reset = () => { setTab(shopQr ? 'qr' : 'charge'); setCustomerQuery(''); setPicked(null); setExpiry('15'); setIntent(null); sender.reset() }
  useEffect(() => { if (!open) reset() }, [open])
  const newPayment = () => { setIntent(null); sender.reset() }

  const who = canBill && picked ? cleanUsername(picked.username) : ''
  const validLabel = validFor.find(v => v.id === expiry)?.label ?? '15 min'
  /** The customer for a new order: the picked person, or the exact username
   *  typed (not tapped); anything else typed is an error shown in the form. */
  const resolveCustomer = (): PickedUser | null => {
    if (!canBill) return null
    if (picked) return picked
    if (!customerQuery.trim()) return null
    const exact = exactPick(customerQuery, found.results)
    if (exact) { const u = { id: exact.id, username: cleanUsername(exact.username), display_name: exact.display_name, avatar_url: exact.avatar_url }; setPicked(u); setCustomerQuery(''); return u }
    if (found.searching) throw new Error('Still looking up that username - try again')
    throw new Error(pickerProblem(customerQuery, { searching: false, found: 0, self: false })?.text ?? 'Pick a MeshPort user')
  }
  /** Makes the order (a failure shows in the form), shows its QR and, with a
   *  customer, posts its card into your chat with them in the background. */
  const create = async (p: RequestInput, kind: 'charge' | 'bill') => {
    const person = resolveCustomer()
    const it = await make({ ...p, customer: person ? cleanUsername(person.username) : undefined })
    setIntent(it)
    onChanged?.()
    if (chat && person) {
      const amountText = formatAmount(it.amount)
      void sender.send({ id: person.id, name: person.display_name || `${cleanUsername(person.username)}.arc` },
        kind === 'bill' ? billCardMessage(it, amountText) : paymentRequestMessage(it, amountText))
    } else sender.reset()
    return it
  }
  const cancel = async () => {
    // Before the first status read the order is still open: cancel it too.
    if (intent && (!view || OPEN.has(view.status))) {
      const ok = await cancelPayment(intent.code).then(() => true, () => false); onChanged?.()
      if (ok) log('order_cancelled', { target: intent.orderNumber ?? intent.code, amount: intent.amount })
    }
    setIntent(null)
  }

  const tabs: { id: CollectTab; label: string }[] = [
    ...(shopQr ? [{ id: 'qr' as const, label: 'Shop QR' }] : []),
    { id: 'charge', label: 'Request' },
    ...(canBill ? [{ id: 'bill' as const, label: 'Bill' }] : []),
  ]
  const outlet = shopQr?.outlet ?? null
  // The store's handle beside its name (not twice when the name is the handle).
  const handle = shopQr && cleanUsername(shopQr.handle) !== cleanUsername(storeName) ? shopQr.handle : null
  // The sheet's top: the store (like the person in a chat sheet) + the tabs.
  // Phone with several stores: the store is the chip in the title row, so
  // just the tabs here.
  // Phone: the title is the business - its logo and name, with the store
  // under it (tap to switch) or, with one store, its handle.
  // An order made: the title names it ("Bill #124 · Cutting Edge") in place
  // of the store switch, and the order screen drops its own person row.
  const heading = isDesktop ? undefined : intent
    ? <BusinessTitle business={storeName} avatar={avatar} line={[`${intent.kind === 'invoice' ? 'Bill' : 'Request'} ${intent.orderNumber ? displayOrderNumber(intent.orderNumber) : ''}`.trim(),
        intent.kind === 'invoice' && intent.customerUsername ? `for ${cleanUsername(intent.customerUsername)}.arc` : null, outlet].filter(Boolean).join(' · ')} />
    : businessHeading(storeName, avatar, shopQr?.handle ?? 'Collect payment', storePick)
  const head = (compact: boolean) => (
    <div>
      {isDesktop && <SheetPerson label="Collect payment" name={storeName} username={handle} compact={compact} onClose={onBack} sub={outlet} />}
      {!compact && tabs.length > 1 && (
        <div className={`flex p-1 rounded-2xl ${isDesktop ? 'mt-3' : ''}`} role="tablist" aria-label="How to collect" style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}>
          {tabs.map(x => (
            <button key={x.id} type="button" role="tab" aria-selected={tab === x.id} onClick={() => setTab(x.id)}
              className={`flex-1 rounded-xl text-[14px] font-semibold transition-colors ${tab === x.id ? 'bg-surface text-text-primary shadow-sm' : 'text-text-muted'}`}
              style={{ height: 36 }}>
              {x.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
  const customerInput = (label: string, hint?: string) => (
    <UserPicker label={label} hint={hint} query={customerQuery} onQuery={setCustomerQuery} picked={picked} onPick={setPicked}
      active={open && canBill} onResults={(results, searching) => setFound({ results, searching })} />
  )

  let body: React.ReactNode
  if (intent) {
    body = (
      <RequestResult intent={intent} view={view} isDesktop={isDesktop} name={storeName} username={handle} sub={outlet}
        from={shopFrom(storeName, outlet)} validLabel={validLabel}
        sender={sender} onOpenChat={id => navigate(`/chat/${id}`)} onClose={onBack} onCancel={cancel} onNew={newPayment} noPerson={!isDesktop} />
    )
  } else if (tab === 'qr' && shopQr) {
    body = (
      <div className="flex flex-col min-h-0 flex-1">
        <div className="px-5 flex-shrink-0" style={{ paddingTop: isDesktop ? 20 : 4 }}>{head(false)}</div>
        <div className="flex-1 min-h-0 overflow-y-auto" data-no-drag>
          <ShopQrBody active={open} storeName={storeName} outlet={outlet} handle={shopQr.handle} />
        </div>
      </div>
    )
  } else if (tab === 'bill' && canBill) {
    body = (
      <BillComposer open={open} isDesktop={isDesktop} header={head} submitLabel="Create bill" busyLabel="Creating…"
        footerNote={due => `${who ? `${who}.arc gets it ${chat ? 'in your chat' : 'in their notifications'}` : 'Show the QR or send the link'}${due ? ` · ${due}` : ''}`}
        saved={savedItems ? { items: catalog, onRemove: removeSaved, hint: 'Items you bill are saved here for next time' } : undefined}
        extra={<div className="mt-3 mb-1">{customerInput('Bill to (optional)')}</div>}
        onCreate={async ({ items, total, taxPercent, note, dueDate }) => {
          // Same as a chat bill: open 7 days, or until paid with a due date.
          await create({ amount: total, items, taxPercent, note, expiresInMinutes: dueDate ? null : 7 * 24 * 60, dueDate }, 'bill')
          if (savedItems) void rememberItems(items)
        }} />
    )
  } else {
    body = (
      <RequestAmountForm open={open} isDesktop={isDesktop} header={head} verb="Request" busyText="Creating…" places={2}
        ariaLabel="Amount to request in USDC" hint={`${t.customer} scans the QR or opens the link`}
        options={{
          summary: <>Valid for <b className="font-semibold text-text-primary">{validLabel}</b>{canBill && (who
            ? <> · for <b className="font-semibold text-text-primary">{who}.arc</b></>
            : <> · any {t.customer.toLowerCase()}</>)}</>,
          panel: <>
            <div><SheetLabel>Valid for</SheetLabel><SheetChips<ValidFor> label="Valid for" options={validFor} value={expiry} onChange={setExpiry} /></div>
            {canBill && customerInput(`${t.customer} (optional)`, chat ? 'A MeshPort user - the request goes into your chat with them.' : 'A MeshPort user - they get it in their notifications.')}
          </>,
        }}
        onSubmit={async (amount, note) => { await create({ amount, note: note || undefined, expiresInMinutes: Number(expiry) || null }, 'charge') }} />
    )
  }

  // Desktop: the centred dialog, like the chat's Request / Bill. Phone: a page
  // that slides in from the right, like every other Business screen.
  if (isDesktop) return <ActionSheet open={open} onClose={onBack} isDesktop id="biz-collect" fixed>{body}</ActionSheet>
  return <BusinessScreen open={open} title="Collect payment" onBack={onBack} fill heading={heading}>{body}</BusinessScreen>
}

// ── Requests ─────────────────────────────────────────────────────────────

// Orders by status: Open (waiting), Partly paid, Paid (incl. completed), Cancelled, Expired.
const FILTERS = [
  { id: 'open', label: 'Open' }, { id: 'part', label: 'Partly paid' }, { id: 'paid', label: 'Paid' },
  { id: 'cancelled', label: 'Cancelled' }, { id: 'expired', label: 'Expired' }, { id: 'all', label: 'All' },
] as const
type OrderFilter = typeof FILTERS[number]['id']
const EMPTY = (o: string): Record<OrderFilter, string> => ({
  open: `No open ${o}`, part: `No partly paid ${o}`, paid: 'Nothing paid yet',
  cancelled: `No cancelled ${o}`, expired: `No expired ${o}`, all: `No ${o} yet`,
})

function requestStatus(i: MerchantIntent): RequestStatus {
  if (i.status === 'paid') return i.completedByMerchant ? 'completed' : 'paid'
  if (i.status === 'cancelled' || i.status === 'failed') return 'cancelled'
  if (i.status === 'expired' || isExpired(i)) return 'expired'
  return i.status === 'partially_paid' ? 'part' : 'open'
}
const filterOf = (s: RequestStatus): OrderFilter => (s === 'completed' ? 'paid' : s) as OrderFilter

/** Business → Payments → Orders: everything the business asked to be paid
 *  (Receive amounts, bills, Shop QR orders), by status, with copy link /
 *  complete / cancel. */
export function RequestsList({ active, storeId, mainStoreId = null, storeName = 'Your business', storeNameOf, paymentsOf, refundedOf, onRefund, staff }: {
  active: boolean; storeId?: string | null
  /** A manager in staff mode: the business's requests for their store
   *  (staff_intents). Only Copy / Share, and Cancel on their own unpaid ones -
   *  reopen, complete, remind and refunds stay with the owner. */
  staff?: { owner: string; me: string | null }
  /** Orders without a store belong to the main store (same as sales). */
  mainStoreId?: string | null
  /** Name in shared links and messages */
  storeName?: string
  /** An order's store (branch) name, shown with the business name when shared */
  storeNameOf?: (i: MerchantIntent) => string | null
  /** The payments on an order (late / blocked sender badges, refunds) */
  paymentsOf?: (i: MerchantIntent) => MerchantPayment[]
  /** Refunded so far on a payment (a payment can be refunded several times) */
  refundedOf?: (p: MerchantPayment) => number
  /** Opens the refund sheet for this payment, prefilled with `amount` */
  onRefund?: (p: MerchantPayment, amount: number) => void
}) {
  const t = useBizTerms()
  const orders = t.orders.toLowerCase()
  const toast = useUIStore(s => s.showToastMessage)
  const [list, setList] = useState<MerchantIntent[] | null>(null)
  const [filter, setFilter] = useState<OrderFilter>('open')
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [sharing, setSharing] = useState<MerchantIntent | null>(null)
  const { copy } = useShare()

  const load = () => (staff ? staffIntents(staff.owner) : listMyIntents(500)).then(setList).catch(() => setList([]))
  useEffect(() => { if (active) { setList(null); void load() } }, [active])

  const inStore = (list ?? []).filter(i => !storeId || (i.storeId ?? mainStoreId) === storeId)
  const counts = useMemo(() => {
    const c: Record<OrderFilter, number> = { open: 0, part: 0, paid: 0, cancelled: 0, expired: 0, all: inStore.length }
    for (const i of inStore) c[filterOf(requestStatus(i))]++
    return c
  }, [inStore])
  const q = query.trim().toLowerCase().replace(/^#/, '')
  const shown = inStore
    .filter(i => filter === 'all' || filterOf(requestStatus(i)) === filter)
    .filter(i => !q || [i.orderNumber, i.orderNumber && displayOrderNumber(i.orderNumber), i.customerUsername, i.note, i.code, i.amount.toFixed(2)]
      .some(v => v && String(v).toLowerCase().includes(q)))
  // What is still owed on the orders in view that can be paid.
  const due = shown.reduce((sum, i) => { const s = requestStatus(i); return s === 'open' || s === 'part' ? sum + Math.max(0, i.amount - i.received) : sum }, 0)

  const act = async (i: MerchantIntent, what: 'cancel' | 'complete' | 'reopen') => {
    setBusy(i.id)
    try {
      const v = await (what === 'cancel' ? cancelPayment(i.code) : what === 'reopen' ? reopenOrder(i.code) : completeOrder(i.code))
      void logBusiness(what === 'cancel' ? 'order_cancelled' : what === 'reopen' ? 'order_reopened' : 'order_completed', { target: i.orderNumber ?? i.code, amount: i.amount, ...(staff ? { owner: staff.owner } : {}) })
      toast(what === 'cancel' ? `${cap(t.order)} cancelled`
        : what === 'reopen' ? (v.status === 'paid' ? `${cap(t.order)} reopened - paid in full` : v.received > 0 ? `${cap(t.order)} reopened - ${money(v.received)} counted` : `${cap(t.order)} reopened`)
        : 'Marked as completed', 'success')
      await load()
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not update', 'error') }
    setBusy(null)
  }
  const remind = async (i: MerchantIntent) => {
    setBusy(i.id)
    try {
      await remindBill(i.id)
      void logBusiness('reminder_sent', { target: i.orderNumber ?? i.code, amount: i.amount - i.received, meta: { customer: i.customerUsername } })
      toast(`Reminder sent to ${i.customerUsername}.arc`, 'success')
      await load()
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not send the reminder', 'error') }
    setBusy(null)
  }
  // What can still go back on a payment, after its refunds so far.
  const leftOn = (p: MerchantPayment) => remainingAfter(p.amount, refundedOf?.(p) ?? 0)
  // The payment to refund on an order: the latest one with that much left.
  const refundable = (i: MerchantIntent, amount: number) => (paymentsOf?.(i) ?? [])
    .filter(p => !p.screenFlag && leftOn(p) + 1e-9 >= Math.max(amount, MIN_REFUND)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
  const shareText = (i: MerchantIntent) => {
    const d = dueText(i.dueDate, true)
    return `${shopFrom(storeName, storeNameOf?.(i))}: ${i.kind === 'invoice' ? 'bill' : t.order} ${i.orderNumber ? displayOrderNumber(i.orderNumber) : ''} for ${money(Math.max(0, i.amount - i.received))}${i.note ? ` - ${i.note}` : ''}${d ? ` (${d.text.toLowerCase()})` : ''}. Pay in USDC:`
  }

  return (
    <>
      {sharing && <ShareSheet open onClose={() => setSharing(null)} title={`Share ${sharing.orderNumber ? displayOrderNumber(sharing.orderNumber) : cap(t.order)}`}
        url={paymentLink(sharing.code)} text={shareText(sharing)}
        subject={`${shopFrom(storeName, storeNameOf?.(sharing))}: ${sharing.kind === 'invoice' ? 'bill' : t.order} ${sharing.orderNumber ? displayOrderNumber(sharing.orderNumber) : ''}`} />}
      <div className="px-5 pt-3">
        <SearchField value={query} onChange={setQuery} ariaLabel={`Search ${orders}`} placeholder={[`Search ${t.order}, ${t.customer.toLowerCase()} or note`, `${cap(t.order)}, ${t.customer.toLowerCase()}, note`, 'Search']} />
      </div>
      <div className="flex gap-2 overflow-x-auto px-5 pt-3 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist" aria-label={`${cap(t.order)} status`}>
        {FILTERS.map(f => {
          const on = f.id === filter
          return (
            <button key={f.id} type="button" role="tab" aria-selected={on} onClick={() => setFilter(f.id)}
              className={`shrink-0 inline-flex items-center gap-1.5 rounded-full px-3.5 min-h-[36px] text-xs font-semibold transition-colors ${on ? 'bg-brand text-white' : 'bg-surface border border-border text-text-secondary'}`}>
              {f.label}
              {counts[f.id] > 0 && <span className={`tabular-nums ${on ? 'text-white/80' : 'text-text-muted'}`}>{counts[f.id]}</span>}
            </button>
          )
        })}
      </div>
      {list !== null && shown.length > 0 && (filter === 'open' || filter === 'part' || filter === 'all') && due > 0 && (
        <p className="px-5 pb-2 text-xs text-text-muted">{money(due)} still to collect</p>
      )}
      <div className="px-5 pb-6">
        {list === null ? (
          <div className="flex flex-col gap-3">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
        ) : shown.length === 0 ? (
          <div className="flex flex-col items-center text-center py-16">
            <span className="inline-flex items-center justify-center size-12 rounded-2xl bg-surface border border-border mb-3"><Clock className="size-5 text-text-muted" /></span>
            <p className="text-sm font-medium text-text-secondary">{q ? `No ${orders} match your search` : EMPTY(orders)[filter]}</p>
            {!q && <p className="text-xs text-text-muted mt-1">Requests and bills you create in Collect payment show up here.</p>}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {shown.map(i => {
              const status = requestStatus(i)
              const live = status === 'open' || status === 'part'
              const pays = paymentsOf?.(i) ?? []
              const blocked = pays.some(p => p.screenFlag)
              const due = dueText(i.dueDate, live)
              // Paid after it was cancelled (or expired): the money is here, the order isn't.
              const afterCancel = (status === 'cancelled' || status === 'expired') && i.received > 0
              // The extra still held: overpaid minus what was already refunded on this order.
              const extraAmt = i.overpaid && i.overpaid > 0 ? extraLeft(i.overpaid, pays.reduce((s, p) => s + (refundedOf?.(p) ?? 0), 0)) : 0
              const extra = extraAmt + 1e-9 >= MIN_REFUND ? refundable(i, extraAmt) : undefined
              const back = afterCancel ? refundable(i, 0) : undefined
              // Reopen: cancelled / expired, nothing refunded on it (the server checks too).
              const canReopen = !staff && (status === 'cancelled' || status === 'expired') && i.status !== 'failed' && !pays.some(p => (refundedOf?.(p) ?? 0) > 0)
              const remindIn = canRemindAt(i.lastRemindedAt)
              const badges = [
                ...(due ? [{ label: due.text, tone: due.tone }] : []),
                ...(blocked ? [{ label: 'Blocked sender', tone: 'danger' as const }] : []),
                ...(i.overpaid && i.overpaid > 0 ? [{ label: `Overpaid ${money(i.overpaid)}`, tone: 'warning' as const }] : []),
                ...(afterCancel ? [{ label: `Paid after ${status === 'cancelled' ? 'cancel' : 'expiry'}`, tone: 'danger' as const }] : []),
                ...(!afterCancel && pays.some(p => p.late) ? [{ label: 'Paid late', tone: 'warning' as const }] : []),
              ]
              const note = blocked ? "A payment came from an address on USDC's blocklist. Don't ship goods; contact support."
                : afterCancel ? `${money(i.received)} arrived after this ${t.order} was ${status === 'cancelled' ? 'cancelled' : 'closed'} - reopen it to count the payment, or refund it.`
                : undefined
              return (
                <RequestRow key={i.id} kind={i.kind} status={status} amount={money(i.amount)} badges={badges} note={note}
                  title={i.note || (i.kind === 'invoice' ? 'Bill' : i.via === 'shop_qr' ? 'Shop QR' : 'Payment request')}
                  sub={[i.orderNumber && displayOrderNumber(i.orderNumber), status === 'part' && `${money(i.received)} received`, i.customerUsername && `${i.customerUsername}.arc`,
                    new Date(i.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })].filter(Boolean).join(' · ')}
                  expanded={openId === i.id} onToggle={() => setOpenId(openId === i.id ? null : i.id)}
                  actions={[
                    { label: 'Copy link', tone: 'neutral', onClick: () => { void copy(paymentLink(i.code)); toast('Link copied', 'success') } },
                    ...(live ? [{ label: 'Share', tone: 'neutral' as const, onClick: () => setSharing(i) }] : []),
                    ...(live && i.customerUsername && !staff ? [{ label: remindIn.ok ? 'Remind' : `Remind in ${remindIn.inHours}h`, tone: 'neutral' as const, onClick: () => remind(i), disabled: busy === i.id || !remindIn.ok }] : []),
                    ...(onRefund && extra && !blocked ? [{ label: `Refund extra ${money(extraAmt)}`, tone: 'danger' as const, onClick: () => onRefund(extra, extraAmt) }] : []),
                    ...(onRefund && back && !blocked ? [{ label: 'Refund', tone: 'danger' as const, onClick: () => onRefund(back, leftOn(back)) }] : []),
                    ...(canReopen ? [{ label: 'Reopen', tone: 'brand' as const, onClick: () => act(i, 'reopen'), disabled: busy === i.id }] : []),
                    ...(live && !staff ? [{ label: 'Mark completed', tone: 'brand' as const, onClick: () => act(i, 'complete'), disabled: busy === i.id }] : []),
                    // Only an order nothing was paid on can be cancelled (the server refuses the rest).
                    ...(status === 'open' && i.received <= 0 && (!staff || (!!staff.me && i.createdByStaff === staff.me)) ? [{ label: 'Cancel', tone: 'danger' as const, onClick: () => act(i, 'cancel'), disabled: busy === i.id }] : []),
                  ]} />
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}

// ── Insights ─────────────────────────────────────────────────────────────

function InsightsBody({ payments, waiting, period, scope, compare }: {
  payments: MerchantPayment[]; waiting: string
  /** Every store's own sales in the period, side by side (never added up). */
  compare?: { id: string; name: string; isDefault: boolean; total: number; count: number }[]
  /** The Business date filter - Insights reads the same range. */
  period: { from: Date; to: Date; label: string }
  /** Active store name when the owner has picked one. */
  scope?: string | null
}) {
  const t = useBizTerms()
  const data = useMemo(() => {
    const from = period.from.getTime(), to = period.to.getTime()
    const list = payments.filter(p => { const t = Date.parse(p.createdAt); return t >= from && t < to })
    const total = list.reduce((s, p) => s + p.amount, 0)
    const rank = (key: (p: MerchantPayment) => string) => {
      const m = new Map<string, { total: number; count: number }>()
      for (const p of list) { const k = key(p); const v = m.get(k) ?? { total: 0, count: 0 }; v.total += p.amount; v.count++; m.set(k, v) }
      return [...m.entries()].sort((a, b) => b[1].total - a[1].total)
    }
    const hours = salesByHour(list)
    const peak = hours.indexOf(Math.max(...hours))
    // Bars across the range: 3-hour blocks for a day, days up to two weeks,
    // weeks up to two months, then months.
    const days = Math.max(1, Math.round((to - from) / 86_400_000))
    const step = days <= 1 ? 3 * 3_600_000 : days <= 14 ? 86_400_000 : days <= 62 ? 7 * 86_400_000 : 0
    const buckets: { start: number; end: number; label: string }[] = []
    if (step) {
      for (let t = from; t < to; t += step) {
        const d = new Date(t)
        buckets.push({ start: t, end: Math.min(t + step, to),
          label: days <= 1 ? hourLabel(d.getHours()) : days <= 14 ? (days <= 7 ? d.toLocaleDateString([], { weekday: 'short' }) : String(d.getDate()))
            : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) })
      }
    } else {
      for (let d = new Date(period.from); d.getTime() < to; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
        const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
        buckets.push({ start: d.getTime(), end: Math.min(end, to), label: d.toLocaleDateString([], { month: 'short' }) })
      }
    }
    return {
      total, count: list.length,
      hours: hours.map((v, h) => ({ label: hourLabel(h), value: v, display: money(v) })),
      peak: hours[peak] > 0 ? `Busiest: ${hourLabel(peak)}` : undefined,
      buyers: new Set(list.map(p => p.customerUsername || p.from.toLowerCase())).size,
      bars: buckets.map(b => {
        const v = list.filter(p => { const t = Date.parse(p.createdAt); return t >= b.start && t < b.end }).reduce((s, p) => s + p.amount, 0)
        return { label: b.label, value: v, display: money(v) }
      }),
      customers: rank(p => p.customerUsername ? `${p.customerUsername}.arc` : /^0x0{40}$/i.test(p.from) ? 'Bridge payment' : `${p.from.slice(0, 6)}…${p.from.slice(-4)}`).slice(0, 5)
        .map(([name, v]) => ({ id: name, left: name, sub: `${v.count} payment${v.count === 1 ? '' : 's'}`, right: money(v.total) })),
      chains: rank(p => p.chain).map(([id, v]) => ({ id, left: chainLabel(id), logo: chainLogoSrc(id), sub: `${Math.round((v.total / (total || 1)) * 100)}% of sales`, right: money(v.total) })),
    }
  }, [payments, period.from.getTime(), period.to.getTime()])

  const label = scope ? `${period.label} · ${scope}` : period.label
  return (
      <div className="flex flex-col gap-6 px-5 pt-4 pb-6">
        <InsightsChart total={money(data.total)} sub={`${label} · ${data.count} payment${data.count === 1 ? '' : 's'}`} bars={data.bars} />
        <StatTriple items={[
          { label: 'Average ticket', value: money(data.count ? data.total / data.count : 0) },
          { label: 'Waiting to settle', value: waiting },
          { label: t.customers, value: String(data.buyers), hint: period.label.toLowerCase() },
        ]} />
        <HourChart title="Sales by hour" sub={period.label} bars={data.hours} peak={data.peak} />
        <RankList title={`Top ${t.customers.toLowerCase()}`} empty={`No ${t.customers.toLowerCase()} in this period`} rows={data.customers} />
        <RankList title="By chain" empty="No payments in this period" rows={data.chains} />
        {compare && compare.length > 1 && (
          <RankList title={`Compare stores · ${period.label}`} empty="" rows={[...compare].sort((a, b) => b.total - a.total).map(c => ({
            id: c.id, left: c.name, right: money(c.total),
            sub: `${c.isDefault ? 'Main store · ' : ''}${c.count} payment${c.count === 1 ? '' : 's'}`,
          }))} />
        )}
      </div>
  )
}

// ── Business profile / approval ──────────────────────────────────────────

/** Smallest / largest amount customers can type on the business QR and payment link. */
function ShopLimitsCard({ open, handle }: { open: boolean; handle: string }) {
  const toast = useUIStore(s => s.showToastMessage)
  const [min, setMin] = useState('')
  const [max, setMax] = useState('')
  const [saved, setSaved] = useState({ min: '', max: '' })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    getShopLimits(handle).then(l => {
      const v = { min: l.min != null ? String(l.min) : '', max: l.max != null ? String(l.max) : '' }
      setSaved(v); setMin(v.min); setMax(v.max)
    }).catch(() => {})
  }, [open, handle])
  const num = (v: string) => (v.trim() ? Number(v) : null)
  const lo = num(min), hi = num(max)
  const err = (lo != null && !(lo >= 0.01)) || (hi != null && !(hi >= 0.01)) ? 'Enter amounts of at least $0.01'
    : lo != null && hi != null && lo > hi ? 'Minimum is more than the maximum' : null
  const save = async () => {
    setBusy(true)
    try { await setShopLimits(lo, hi); setSaved({ min, max }); void logBusiness('limits_changed', { meta: { min: lo, max: hi } }); toast(lo == null && hi == null ? 'Limits removed' : 'Limits saved', 'success') }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not save', 'error') }
    setBusy(false)
  }
  const clean = (v: string) => v.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1').slice(0, 9)
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-surface border border-border p-4">
      <span>
        <span className="block text-sm font-semibold text-text-primary">Payment limits</span>
        <span className="block text-xs text-text-muted">For amounts customers type on your QR and payment link. Leave empty for no limit.</span>
      </span>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Minimum ($)"><TextInput inputMode="decimal" value={min} onChange={e => setMin(clean(e.target.value))} placeholder="No minimum" /></Field>
        <Field label="Maximum ($)"><TextInput inputMode="decimal" value={max} onChange={e => setMax(clean(e.target.value))} placeholder="No maximum" /></Field>
      </div>
      {err && <p className="text-xs font-semibold text-danger">{err}</p>}
      <button type="button" onClick={save} disabled={busy || !!err || (min === saved.min && max === saved.max)}
        className="min-h-[44px] rounded-2xl bg-brand text-white text-sm font-semibold disabled:opacity-40">
        {busy ? 'Saving…' : 'Save limits'}
      </button>
    </div>
  )
}

export function ProfileScreen({ open, onBack, handle }: { open: boolean; onBack: () => void; handle: string }) {
  const toast = useUIStore(s => s.showToastMessage)
  const { status, application, storeName } = useMerchant()
  const navigate = useNavigate()
  const avatar = useAuthStore(s => s.user?.avatar ?? null)
  const [bizName, setBizName] = useState(storeName ?? '')
  const [savingName, setSavingName] = useState(false)
  useEffect(() => { if (open) setBizName(storeName ?? '') }, [open, storeName])
  const saveName = async () => {
    setSavingName(true)
    try { await setBusinessName(bizName); toast(bizName.trim() ? 'Business name saved' : 'Business name removed', 'success') }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not save', 'error') }
    setSavingName(false)
  }
  const [contact, setContact] = useState(() => application?.contact || '')
  const [reason, setReason] = useState('')
  const [registration, setRegistration] = useState('')
  const [docs, setDocs] = useState<BusinessDoc[]>([])
  const [bizType, setBizType] = useState<string>(() => toCategory(application?.businessType))
  // The application can load after this screen mounts: prefill from it.
  useEffect(() => {
    if (!open) return
    setContact(application?.contact || ''); setBizType(toCategory(application?.businessType))
  }, [open, application?.id])
  const appliedName = application?.businessName && !/\.arc$/i.test(application.businessName) ? application.businessName : ''
  const [busy, setBusy] = useState(false)
  const [again, setAgain] = useState(false)

  const closed = status === 'rejected' || status === 'revoked'
  const canApply = status === 'none' || (closed && again)
  const submit = async () => {
    setBusy(true)
    // The application carries the business name customers will see; the
    // account stays its username and shops are added as stores after approval.
    try {
      await applyForMerchant({ businessName: bizName, businessType: bizType, contact, description: reason, registrationNumber: registration, documents: docs })
      if (bizName.trim() !== (storeName ?? '')) await setBusinessName(bizName).catch(() => {})
      toast('Sent for review', 'success'); setAgain(false); setDocs([]); setRegistration('')
    }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not send', 'error') }
    setBusy(false)
  }

  const card: { tone: StatusCardTone; title: string; text: string } =
    status === 'approved' ? { tone: 'success', title: 'Verified business', text: 'All merchant tools are on. Add your shops in Stores & staff.' }
    : status === 'pending' ? { tone: 'warning', title: 'Under review', text: "MeshPort is reviewing your business. You'll get a notification when it's approved." }
    : closed ? { tone: 'danger', title: status === 'revoked' ? 'Merchant access removed' : 'Not approved', text: application?.reviewNote || 'Check the details and send it again.' }
    : { tone: 'brand', title: 'Apply for business approval', text: 'Add your business name and tell MeshPort why you need a business account. Payments, orders and business tools turn on once approved.' }

  return (
    <BusinessScreen open={open} title="Business profile" onBack={onBack}
      footer={canApply ? <PrimaryBtn disabled={busy || bizName.trim().length < 2 || reason.trim().length < 10 || !docs.length} onClick={submit}>{busy ? 'Sending…' : 'Send for review'}</PrimaryBtn>
        : closed ? <PrimaryBtn onClick={() => { setBizName(n => n || appliedName); setAgain(true) }}>Apply again</PrimaryBtn> : undefined}>
      <div className="flex flex-col gap-6 px-5 pt-5 pb-6">
        {/* Name and logo customers see on the pay page, receipts and notifications */}
        <div className="flex flex-col gap-4 rounded-2xl bg-surface border border-border p-4">
          <div className="flex items-center gap-3">
            <Avatar name={bizName || handle} src={avatar ?? undefined} size="lg" />
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-semibold text-text-primary">Logo</span>
              <span className="block text-xs text-text-muted">Your profile photo is your business logo</span>
            </span>
            <button type="button" onClick={() => navigate('/edit-profile')}
              className="shrink-0 min-h-[36px] px-3 rounded-full border border-border text-[13px] font-semibold text-text-primary active:bg-border/30">
              {avatar ? 'Change' : 'Add'}
            </button>
          </div>
          {!canApply && (
            <Field label="Business name" hint={`Customers see this. Leave empty to show ${handle}.`}>
              <div className="flex gap-2">
                <TextInput value={bizName} onChange={e => setBizName(e.target.value)} maxLength={60} placeholder="e.g. Sharma Chai Corner" />
                <button type="button" onClick={saveName} disabled={savingName || bizName.trim() === (storeName ?? '')}
                  className="shrink-0 min-h-[48px] px-4 rounded-2xl bg-brand text-white text-sm font-semibold disabled:opacity-40">
                  {savingName ? 'Saving…' : 'Save'}
                </button>
              </div>
            </Field>
          )}
        </div>
        {status === 'approved' && <ShopLimitsCard open={open} handle={handle} />}
        <ProfileStatusCard {...card} />
        {canApply ? (
          <>
            <Field label="Business name" hint="Your store or business name. Customers see this on the pay page and receipts.">
              <TextInput value={bizName} onChange={e => setBizName(e.target.value)} maxLength={60} placeholder="e.g. Royal Bakes" />
            </Field>
            <Field label="Type">
              <ChipSelect options={BUSINESS_CATEGORIES.map(t => ({ id: t, label: t }))} value={bizType} onChange={setBizType} />
            </Field>
            <Field label="Why do you need a business account?" hint={`${reason.trim().length}/10 characters minimum`}>
              <textarea value={reason} onChange={e => setReason(e.target.value)} maxLength={500} rows={4}
                placeholder="e.g. I run a bakery and want customers to pay in USDC at the counter."
                className="w-full rounded-2xl bg-surface border border-border px-4 py-3 text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-brand resize-none" />
            </Field>
            <Field label="Contact (optional)"><TextInput value={contact} onChange={e => setContact(e.target.value)} maxLength={120} placeholder="Phone or email" /></Field>
            <Field label="Registration number (optional)"><TextInput value={registration} onChange={e => setRegistration(e.target.value)} maxLength={40} placeholder="GST, VAT, EIN, ABN or business licence number" /></Field>
            <Field label="Documents" hint="Add at least one: your ID or a photo of your shop. A registration certificate helps.">
              <BusinessDocsField docs={docs} onChange={setDocs} onError={m => toast(m, 'error')} />
            </Field>
          </>
        ) : (
          <DetailList rows={[
            { label: 'Business', value: application?.businessName && application.businessName !== handle ? `${application.businessName} · ${handle}` : handle },
            ...(application?.businessType ? [{ label: 'Type', value: application.businessType }] : []),
            ...(application?.contact ? [{ label: 'Contact', value: application.contact }] : []),
            ...(application?.registrationNumber ? [{ label: 'Registration', value: application.registrationNumber }] : []),
            ...(application?.documents.length ? [{ label: 'Documents', value: `${application.documents.length} attached` }] : []),
            ...(application ? [{ label: 'Applied', value: new Date(application.createdAt).toLocaleDateString() }] : []),
          ]} />
        )}
      </div>
    </BusinessScreen>
  )
}

// ── Statement ────────────────────────────────────────────────────────────

export function StatementBody({ storeName, handle, payments, refunds, settled, waiting, loading, staff }: {
  storeName: string; handle: string; payments: MerchantPayment[]; refunds: MerchantRefund[]
  settled: { amount: number; createdAt: string }[]; waiting: number; loading: boolean
  /** A manager's statement: no settlement lines (settling is the owner's). */
  staff?: boolean
}) {
  const t = useBizTerms()
  const [range, setRange] = useState<StatementRange>('today')
  const printer = usePrint()
  const rows = statementRows({ range, payments, refunds, settled, waiting, customersLabel: t.customers })
    .filter(r => !staff || (r.label !== 'Settled to Arc' && r.label !== 'Waiting on other chains'))
  const since = rangeStart(range).getTime()
  const inRange = payments.filter(p => Date.parse(p.createdAt) >= since)
  // A payment can have several refunds: "Refunded" when all of it went back.
  const refundedBy = groupRefunds(refunds)
  const status = (p: MerchantPayment) => {
    const r = refundedSum(refundedBy.get(p.id))
    return !r ? 'Paid' : isFullyRefunded(p.amount, r) ? 'Refunded' : `Partly refunded ${money(r)}`
  }
  const name = (p: MerchantPayment) => p.customerUsername ? `${p.customerUsername}.arc` : `${p.from.slice(0, 6)}…${p.from.slice(-4)}`
  const pdf = () => printer.print(
    <PrintableStatement storeName={storeName} handle={handle} periodLabel={rangeLabel(range)} rows={rows}
      payments={inRange.map(p => ({ time: p.createdAt, from: name(p), order: p.orderNumber ? displayOrderNumber(p.orderNumber) : undefined, chain: chainLabel(p.chain), amount: money(p.amount), status: status(p) }))} />)
  return (
    <>
      <div className="px-5 pt-4 pb-6">
        <StatementView range={range} onRange={setRange} loading={loading} rows={rows} periodLabel={rangeLabel(range)}
          onCsv={() => { void exportPaymentsCsv(inRange, storeName, refunds) }} onPdf={pdf} />
      </div>
      {printer.portal}
    </>
  )
}

// ── Reports: Insights + Statement ────────────────────────────────────────

export function ReportsScreen({ open, onBack, insights, statement, storePick }: {
  open: boolean; onBack: () => void
  insights: Parameters<typeof InsightsBody>[0]
  statement: Parameters<typeof StatementBody>[0]
  /** Several stores: the report is for one (Switch picks another). */
  storePick?: { stores: PickerStore[]; value: string; onChange: (id: string) => void; onManage?: () => void }
}) {
  const [view, setView] = useState<'insights' | 'statement'>('insights')
  useEffect(() => { if (!open) setView('insights') }, [open])
  return (
    <BusinessScreen open={open} title="Reports" onBack={onBack}>
      {storePick && storePick.stores.length > 1 && (
        <div className="px-5 pt-4">
          <StorePicker stores={storePick.stores} value={storePick.value} onChange={storePick.onChange} onManage={storePick.onManage}
            label="Report for store" hint="Insights and the statement show this store only" />
        </div>
      )}
      <div className="px-5 pt-4">
        <div className="flex p-1 rounded-2xl bg-surface border border-border" role="tablist" aria-label="Report">
          {([['insights', 'Insights'], ['statement', 'Statement']] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}
              className={`flex-1 min-h-[40px] rounded-xl text-sm font-semibold transition-colors ${view === id ? 'bg-card text-text-primary shadow-sm' : 'text-text-muted'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {view === 'insights' ? <InsightsBody {...insights} /> : <StatementBody {...statement} />}
    </BusinessScreen>
  )
}

// ── Receipt ──────────────────────────────────────────────────────────────

export function ReceiptScreen({ open, onBack, storeName, handle, payment, refunded }: {
  open: boolean; onBack: () => void; storeName: string; handle: string; payment: MerchantPayment | null; refunded: boolean
}) {
  const printer = usePrint()
  const { share } = useShare()
  const terms = useBizTerms()
  if (!payment) return <BusinessScreen open={false} title="Receipt" onBack={onBack}>{null}</BusinessScreen>
  const from = payment.customerUsername ? `${payment.customerUsername}.arc` : `${payment.from.slice(0, 6)}…${payment.from.slice(-4)}`
  const card = (printable: boolean) => (
    <ReceiptCard storeName={storeName} handle={handle} amount={money(payment.amount)} from={from} chainLabel={chainLabel(payment.chain)}
      order={payment.orderNumber ? displayOrderNumber(payment.orderNumber) : undefined} time={payment.createdAt} txHash={payment.txHash} refunded={refunded} printable={printable} />
  )
  const text = [`Receipt from ${storeName} (${handle})`, `${money(payment.amount)} USDC${refunded ? ' - refunded' : ''}`,
    payment.orderNumber ? `${cap(terms.order)} ${displayOrderNumber(payment.orderNumber)}` : '', `Paid by ${from} on ${chainLabel(payment.chain)}`,
    new Date(payment.createdAt).toLocaleString(), `Transaction ${payment.txHash}`].filter(Boolean).join('\n')
  return (
    <BusinessScreen open={open} title="Receipt" onBack={onBack}
      footer={<div className="grid grid-cols-2 gap-3">
        <GhostBtn onClick={() => printer.print(card(true))}>Print</GhostBtn>
        <PrimaryBtn onClick={() => share(text, `${window.location.origin}/paylink/${handle.replace(/\.arc$/, '')}`)}>Send receipt</PrimaryBtn>
      </div>}>
      <div className="px-5 pt-5 pb-6 flex flex-col items-center gap-4">
        {card(false)}
        <div className="w-full max-w-[360px]">
          <p className="text-xs text-text-muted mb-2">Send it on</p>
          <ShareChannels subject={`Receipt from ${storeName}${payment.orderNumber ? ` · ${displayOrderNumber(payment.orderNumber)}` : ''}`} text={text} />
        </div>
      </div>
      {printer.portal}
    </BusinessScreen>
  )
}

// ── Help & disputes ──────────────────────────────────────────────────────

const HELP_CHAINS = ['Arc_Testnet', 'Base_Sepolia', 'Ethereum_Sepolia', 'Arbitrum_Sepolia', 'Optimism_Sepolia', 'Polygon_Sepolia', 'Avalanche_Fuji']
const FAQ = [
  { q: 'A customer says they paid but nothing shows', a: 'Ask for the transaction hash (it is in their wallet history), pick the chain and the order, then Check & attach. MeshPort reads it from the chain and adds it to the order if it paid your wallet.' },
  { q: 'A payment came in without an order', a: 'It shows under "Payments without an order". Pick the open order it belongs to and tap Assign.' },
  { q: 'How do I refund?', a: 'Open the payment in Payments and tap Refund. The USDC goes back to the wallet that paid, on the chain it was paid on: from your Arc balance for Arc payments; for another chain, from your USDC still there, or from Arc by CCTP to that chain. You can refund a payment in parts, several times, up to what they paid.' },
  { q: 'When does money from other chains reach Arc?', a: 'When you settle. Settlements moves it over CCTP and MeshPort pays the gas; it usually arrives in a few minutes.' },
]

export function HelpScreen({ open, onBack }: { open: boolean; onBack: () => void }) {
  const t = useBizTerms()
  const toast = useUIStore(s => s.showToastMessage)
  const [chain, setChain] = useState('Arc_Testnet')
  const [txHash, setTxHash] = useState('')
  const [orders, setOrders] = useState<MerchantIntent[]>([])
  const [order, setOrder] = useState('')
  const [unmatched, setUnmatched] = useState<UnmatchedDeposit[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ tone: 'success' | 'danger' | 'warning'; title: string; text: string }>()

  const load = () => {
    listMyIntents(500).then(l => {
      const open = l.filter(i => OPEN.has(i.status) && !isExpired(i))
      setOrders(open); setOrder(o => o || open[0]?.code || '')
    }).catch(() => {})
    listUnmatchedDeposits().then(setUnmatched).catch(() => setUnmatched([]))
  }
  useEffect(() => { if (open) { setResult(undefined); load() } }, [open])

  const check = async () => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash.trim())) { setResult({ tone: 'warning', title: 'Check the hash', text: 'A transaction hash starts with 0x and has 64 characters after it.' }); return }
    if (!order) { setResult({ tone: 'warning', title: `Pick the ${t.order}`, text: `Choose the open ${t.order} this payment was for.` }); return }
    setBusy(true); setResult(undefined)
    try {
      const v = await submitPayment(order, chain, txHash.trim(), { merchantVerify: true })
      setResult(v.status === 'paid' || v.status === 'processing' || v.status === 'partially_paid'
        ? { tone: 'success', title: 'Payment found', text: `${money(v.received)} attached to ${v.orderNumber ? displayOrderNumber(v.orderNumber) : 'the order'}.` }
        : { tone: 'warning', title: 'Still checking', text: 'The transaction is not confirmed yet. Try again in a minute.' })
      load()
    } catch (e) {
      setResult({ tone: 'danger', title: 'Not a payment to you', text: e instanceof Error ? e.message : 'MeshPort could not match this transaction.' })
    }
    setBusy(false)
  }
  const assign = async (id: string) => {
    if (!order) { toast(`Pick an open ${t.order} first`, 'error'); return }
    try { await assignDeposit(id, order); toast('Payment assigned', 'success'); load() }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not assign', 'error') }
  }

  return (
    <BusinessScreen open={open} title="Help & disputes" onBack={onBack}>
      <div className="px-5 pt-5 pb-6">
        <HelpView chains={HELP_CHAINS.map(id => ({ id, label: chainLabel(id), logo: chainLogoSrc(id) }))} chain={chain} onChain={setChain}
          txHash={txHash} onTxHash={setTxHash}
          orders={orders.map(i => ({ code: i.code, label: `${i.orderNumber ? displayOrderNumber(i.orderNumber) : cap(t.order)} · ${money(i.amount - i.received)}` }))} order={order} onOrder={setOrder}
          busy={busy} result={result} onCheck={check}
          unmatched={unmatched.map(u => ({ id: u.id, amount: money(u.amount), from: `${u.from.slice(0, 6)}…${u.from.slice(-4)}`, chainLabel: chainLabel(u.chain), when: u.createdAt }))}
          onAssign={id => { void assign(id) }} faq={FAQ} />
      </div>
    </BusinessScreen>
  )
}

// ── Customers ────────────────────────────────────────────────────────────
// Everyone who paid the business (the selected store), from its payments:
// MeshPort users by username, others by wallet; bridge payments (no paying
// wallet on that chain) are grouped. Named customers also get their credit
// ledger (khata): billed, paid and outstanding on their bills, with
// reminders. Tap one for their payments and open bills.

type Customer = {
  key: string; name: string; username: string | null; wallet: string | null; bridge: boolean
  payments: MerchantPayment[]; total: number; last: string; refunded: number
}

const ZERO_WALLET = /^0x0{40}$/i
const shortWallet = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`
const toKhataOrder = (i: MerchantIntent) => ({ customerUsername: i.customerUsername, amount: i.amount, received: i.received, status: i.status, expiresAt: i.expiresAt, dueDate: i.dueDate ?? null, completedByMerchant: i.completedByMerchant })

export function CustomersScreen({ open, onBack, payments, refundedIds, onPayment, onChat, orders = [], onOrdersChanged }: {
  open: boolean; onBack: () => void; payments: MerchantPayment[]
  /** Refunded payments still list the customer but don't count in totals */
  refundedIds: Set<string>
  onPayment: (p: MerchantPayment) => void; onChat: (username: string) => void
  /** The business's orders (credit ledger: billed, paid, outstanding) */
  orders?: MerchantIntent[]
  /** A reminder was sent (refreshes the orders) */
  onOrdersChanged?: () => void
}) {
  const t = useBizTerms()
  const title = t.customers
  const toast = useUIStore(s => s.showToastMessage)
  const { copy } = useShare()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => { if (!open) { setQuery(''); setSelected(null) } }, [open])

  const khata = useMemo(() => khataByCustomer(orders.map(toKhataOrder)), [orders])
  const outstanding = totalOutstanding(khata)

  const customers = useMemo(() => {
    const m = new Map<string, Customer>()
    for (const p of payments) {
      const bridge = !p.customerUsername && ZERO_WALLET.test(p.from)
      const key = p.customerUsername ? customerKey(p.customerUsername) : bridge ? 'bridge' : `w:${p.from.toLowerCase()}`
      const c = m.get(key) ?? {
        key, bridge, username: p.customerUsername ?? null, wallet: p.customerUsername || bridge ? null : p.from,
        name: p.customerUsername ? `${p.customerUsername}.arc` : bridge ? 'Bridge payments' : shortWallet(p.from),
        payments: [], total: 0, last: p.createdAt, refunded: 0,
      }
      c.payments.push(p)
      if (refundedIds.has(p.id)) c.refunded++
      else c.total += p.amount
      if (Date.parse(p.createdAt) > Date.parse(c.last)) c.last = p.createdAt
      m.set(key, c)
    }
    // Billed customers who haven't paid yet are customers too.
    for (const i of orders) {
      if (!i.customerUsername || !khata.get(customerKey(i.customerUsername))?.billed) continue
      const key = customerKey(i.customerUsername)
      const c = m.get(key)
      if (!c) m.set(key, { key, bridge: false, username: i.customerUsername, wallet: null, name: `${i.customerUsername}.arc`, payments: [], total: 0, last: i.createdAt, refunded: 0 })
      else if (Date.parse(i.createdAt) > Date.parse(c.last)) c.last = i.createdAt
    }
    return [...m.values()].sort((a, b) => (khata.get(b.key)?.outstanding ?? 0) - (khata.get(a.key)?.outstanding ?? 0) || b.total - a.total)
  }, [payments, refundedIds, orders, khata])
  const q = query.trim().toLowerCase()
  const shown = q ? customers.filter(c => c.name.toLowerCase().includes(q) || (c.wallet ?? '').toLowerCase().includes(q)) : customers
  const current = customers.find(c => c.key === selected) ?? null
  const currentKhata = current ? khata.get(current.key) : undefined
  const openBills = useMemo(() => !current?.username ? [] : orders
    .filter(i => i.customerUsername && customerKey(i.customerUsername) === current.key && isOutstanding(toKhataOrder(i)))
    .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || Date.parse(a.createdAt) - Date.parse(b.createdAt)), [orders, current?.key])

  const remindOne = async (i: MerchantIntent) => {
    setBusy(i.id)
    try {
      await remindBill(i.id)
      void logBusiness('reminder_sent', { target: i.orderNumber ?? i.code, amount: i.amount - i.received, meta: { customer: i.customerUsername } })
      toast(`Reminder sent to ${i.customerUsername}.arc`, 'success'); onOrdersChanged?.()
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not send the reminder', 'error') }
    setBusy(null)
  }
  const remindAll = async (c: Customer) => {
    if (!c.username) return
    setBusy('all')
    try {
      const n = await remindCustomer(c.username)
      void logBusiness('reminder_sent', { target: c.name, amount: khata.get(c.key)?.outstanding ?? null, meta: { customer: c.username, bills: n } })
      toast(`Reminder sent to ${c.name} for ${n} ${n === 1 ? t.order : t.orders.toLowerCase()}`, 'success'); onOrdersChanged?.()
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not send the reminder', 'error') }
    setBusy(null)
  }

  const avatar = (c: Customer, size: number) => (
    <span className="shrink-0 rounded-full p-[2px] bg-brand" style={{ width: size, height: size }}>
      <span className="flex items-center justify-center w-full h-full rounded-full bg-brand text-white font-bold text-sm" style={{ border: '2px solid var(--bg)' }}>
        {c.bridge ? '⇄' : c.username ? c.username[0].toUpperCase() : '0x'}
      </span>
    </span>
  )
  const sub = (c: Customer) => `${c.username ? '' : c.bridge ? 'Through a bridge · ' : 'Not on MeshPort · '}${c.payments.length} payment${c.payments.length === 1 ? '' : 's'}${c.refunded ? ` · ${c.refunded} refunded` : ''}`
  const stat = (label: string, value: string, tone = 'text-text-primary') => (
    <div className="rounded-2xl bg-surface border border-border px-4 py-3 min-w-0">
      <p className="text-xs text-text-muted truncate">{label}</p>
      <p className={`text-lg font-bold tabular-nums truncate ${tone}`}>{value}</p>
    </div>
  )

  return (
    <BusinessScreen open={open} title={current ? current.name : title} onBack={current ? () => setSelected(null) : onBack} step={current?.key ?? ''}>
      {current ? (
        <div className="flex flex-col gap-5 px-5 pt-2 pb-6">
          <div className="flex items-center gap-3 rounded-2xl bg-surface border border-border p-4">
            {avatar(current, 52)}
            <span className="flex-1 min-w-0">
              <span className="block text-[15px] font-bold text-text-primary truncate">{current.name}</span>
              <span className="block text-xs text-text-muted truncate">{sub(current)} · last {timeAgo(current.last)}</span>
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {stat('Total paid', money(current.total))}
            {stat('Average', money(current.payments.length > current.refunded ? current.total / (current.payments.length - current.refunded) : 0))}
          </div>
          {currentKhata && currentKhata.billed > 0 && (
            <div className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between">
                <p className="text-base font-bold text-text-primary">Credit ledger</p>
                {currentKhata.overdue > 0 && <span className="text-xs font-semibold text-danger">{currentKhata.overdue} overdue</span>}
              </div>
              <div className="grid grid-cols-3 gap-2">
                {stat('Billed', money(currentKhata.billed))}
                {stat('Paid', money(currentKhata.paid))}
                {stat('Outstanding', money(currentKhata.outstanding), currentKhata.outstanding > 0 ? 'text-warning' : 'text-text-primary')}
              </div>
              {openBills.length > 0 && (
                <div className="rounded-2xl bg-surface border border-border overflow-hidden divide-y divide-border">
                  {openBills.map(i => {
                    const d = dueText(i.dueDate, true)
                    const r = canRemindAt(i.lastRemindedAt)
                    return (
                      <div key={i.id} className="flex items-center gap-3 px-4 py-3">
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-medium text-text-primary truncate">{i.orderNumber ? displayOrderNumber(i.orderNumber) : cap(t.order)}{i.note ? ` · ${i.note}` : ''}</span>
                          <span className={`block text-xs truncate ${d ? dueTone[d.tone] : 'text-text-muted'}`}>
                            {[d?.text, i.received > 0 && `${money(i.received)} of ${money(i.amount)} paid`].filter(Boolean).join(' · ') || new Date(i.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}
                          </span>
                        </span>
                        <span className="text-sm font-semibold tabular-nums text-text-primary">{money(i.amount - i.received)}</span>
                        <button type="button" onClick={() => remindOne(i)} disabled={!!busy || !r.ok}
                          className="shrink-0 min-h-[36px] px-3 rounded-full border border-border text-[13px] font-semibold text-text-primary active:bg-border/30 disabled:opacity-40">
                          {r.ok ? 'Remind' : `${r.inHours}h`}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
              {openBills.length > 1 && (
                <GhostBtn disabled={!!busy} onClick={() => remindAll(current)}>{busy === 'all' ? 'Sending…' : 'Send reminder for all'}</GhostBtn>
              )}
            </div>
          )}
          {current.username ? (
            <PrimaryBtn onClick={() => onChat(current.username!)}>Chat with {current.name}</PrimaryBtn>
          ) : current.wallet ? (
            <GhostBtn onClick={() => { void copy(current.wallet!); toast('Address copied', 'success') }}>Copy wallet address</GhostBtn>
          ) : null}
          {current.payments.length > 0 && (
            <div>
              <p className="text-base font-bold text-text-primary mb-3">Payments</p>
              <div className="rounded-2xl bg-surface border border-border overflow-hidden divide-y divide-border">
                {current.payments.map(p => (
                  <button key={p.id} type="button" onClick={() => onPayment(p)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-border/20">
                    <img decoding="async" src={chainLogoSrc(p.chain)} alt="" className="size-8 rounded-full shrink-0" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-text-primary truncate">{p.orderNumber ? displayOrderNumber(p.orderNumber) : chainLabel(p.chain)}</span>
                      <span className="block text-xs text-text-muted">{chainLabel(p.chain)} · {new Date(p.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span>
                    </span>
                    <span className={`text-sm font-semibold tabular-nums ${refundedIds.has(p.id) ? 'text-text-muted line-through' : 'text-brand-text'}`}>+{money(p.amount)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4 px-5 pt-2 pb-6">
          <SearchField value={query} onChange={setQuery} ariaLabel={`Search ${t.customers.toLowerCase()}`} placeholder={['Search name or wallet', 'Search']} />
          {customers.length > 0 && (
            <div className="grid grid-cols-2 gap-2.5">
              {stat(`Paid · ${customers.length} ${(customers.length === 1 ? t.customer : t.customers).toLowerCase()}`, money(customers.reduce((s, c) => s + c.total, 0)))}
              {stat('Outstanding', money(outstanding), outstanding > 0 ? 'text-warning' : 'text-text-primary')}
            </div>
          )}
          {shown.length === 0 ? (
            <div className="flex flex-col items-center text-center py-16">
              <p className="text-sm font-medium text-text-secondary">{q ? `No ${t.customer.toLowerCase()} matches` : `No ${t.customers.toLowerCase()} yet`}</p>
              <p className="text-xs text-text-muted mt-1">People who pay you show up here.</p>
            </div>
          ) : (
            <div className="rounded-2xl bg-surface border border-border overflow-hidden divide-y divide-border">
              {shown.map(c => {
                const k = khata.get(c.key)
                return (
                  <button key={c.key} type="button" onClick={() => setSelected(c.key)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-border/20">
                    {avatar(c, 42)}
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-semibold text-text-primary truncate">{c.name}</span>
                      <span className="block text-xs text-text-muted truncate">{c.payments.length || !k ? sub(c) : `${k.open} open ${(k.open === 1 ? t.order : t.orders).toLowerCase()}`} · {timeAgo(c.last)}</span>
                    </span>
                    <span className="flex flex-col items-end shrink-0">
                      <span className="text-sm font-semibold tabular-nums text-text-primary">{money(c.total)}</span>
                      {k && k.outstanding > 0 && <span className={`text-[11px] font-semibold tabular-nums ${k.overdue ? 'text-danger' : 'text-warning'}`}>{money(k.outstanding)} due</span>}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </BusinessScreen>
  )
}
