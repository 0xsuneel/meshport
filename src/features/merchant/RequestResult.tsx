// One payment request (or bill) after it's made: the amount, a counter QR, its
// live status and a link to send, then Cancel / New. Business → Collect
// payment and Receive → Request show this same screen, so a request looks and
// works the same for a shop and a person.
import { useEffect, useState } from 'react'
import { CalendarClock, Share2, MessageCircle, MessageSquare, Mail } from 'lucide-react'
import { useUIStore } from '@/store'
import { drawMeshportQr } from '@/lib/qrLogo'
import { paymentLink, watchPayment, displayOrderNumber, invoiceBreakdown, type InvoiceItem, type MerchantIntent, type PaymentView } from '@/lib/merchantPay'
import { dueText } from '@/lib/businessBills'
import { shareChannels } from '@/lib/shareLinks'
import { SheetPerson } from '@/components/ui/ActionSheet'
import { ChatSentLine } from '@/components/ui/ChatSentLine'
import type { useChatCardSender } from '@/hooks/useChatCardSender'
import { QrCard, QrInfoBox } from '@/features/business/ui/QrCard'
import { LiveStatus, type LiveStatusKind } from '@/features/business/ui/LiveStatus'
import { ShareLink } from '@/features/business/ui/ShareLink'
import { DetailList } from '@/features/business/ui/ProfileCards'
import { Sheet } from '@/features/business/ui/primitives'

export const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const OPEN = new Set(['pending', 'payment_detected', 'processing', 'partially_paid'])

/** How long a new request stays open (minutes; '0' = no limit). */
export const VALID_FOR = [
  { id: '15', label: '15 min' }, { id: '60', label: '1 hour' }, { id: '1440', label: '1 day' },
  { id: '10080', label: '7 days' }, { id: '0', label: 'No limit' },
] as const
export type ValidFor = typeof VALID_FOR[number]['id']

export const dueTone = { neutral: 'text-text-muted', warning: 'text-warning', danger: 'text-danger' } as const

/** A QR image (data URL) for `value` - the MeshPort QR with the logo badge,
 *  ~464px so it also prints sharp on a counter sticker. */
export function useQr(value: string | null) {
  const [src, setSrc] = useState<string>()
  useEffect(() => {
    setSrc(undefined)
    if (!value) return
    let live = true
    const cv = document.createElement('canvas')
    drawMeshportQr(cv, value, Math.ceil(464 / Math.max(1, Math.min(4, window.devicePixelRatio || 1))))
      .then(() => { if (live) setSrc(cv.toDataURL('image/png')) }).catch(() => {})
    return () => { live = false }
  }, [value])
  return src
}

export function useShare() {
  const toast = useUIStore(s => s.showToastMessage)
  const [copied, setCopied] = useState(false)
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1600) }
    catch { toast('Could not copy', 'error') }
  }
  const share = async (text: string, url: string) => {
    if (navigator.share) { try { await navigator.share({ text, url }) } catch { /* closed */ } return }
    void copy(`${text} ${url}`)
  }
  return { copied, copy, share }
}

export function LinkShare({ url, text, subject }: { url: string; text: string
  /** With a subject, WhatsApp / SMS / Email buttons are shown too */ subject?: string }) {
  const { copied, copy, share } = useShare()
  return <ShareLink url={url} copied={copied} onCopy={() => copy(url)} onShare={() => share(text, url)}
    channels={subject ? { subject, text: `${text}\n${url}` } : undefined} />
}

const CHANNEL_ICON = { whatsapp: MessageCircle, sms: MessageSquare, email: Mail } as const

/** Share · WhatsApp · SMS · Email in one row - a waiting request's link
 *  (the card's Pay link box copies it). */
function ShareRow({ url, text, subject }: { url: string; text: string; subject: string }) {
  const { share } = useShare()
  const cls = 'min-h-[48px] flex flex-col items-center justify-center gap-0.5 rounded-2xl border border-border bg-surface text-[12px] font-semibold text-text-primary active:scale-[0.97] transition-transform'
  return (
    <div className="grid grid-cols-4 gap-2 w-full max-w-[340px]">
      <button type="button" onClick={() => void share(text, url)} className={cls}><Share2 className="size-4 text-brand-text" />Share</button>
      {shareChannels(subject, `${text}\n${url}`).map(c => {
        const Icon = CHANNEL_ICON[c.id]
        return <a key={c.id} href={c.href} target={c.id === 'whatsapp' ? '_blank' : undefined} rel="noreferrer" className={cls}><Icon className="size-4 text-brand-text" />{c.label}</a>
      })}
    </div>
  )
}

/** A waiting bill's items, from its amount box on the card: the list with
 *  subtotal, tax and total, in a sheet - so the QR and share buttons stay on
 *  screen. */
function BillItemsSheet({ open, onClose, items, taxPercent, note, title }: {
  open: boolean; onClose: () => void; items: InvoiceItem[]; taxPercent?: number; note?: string | null; title: string
}) {
  const b = invoiceBreakdown(items, taxPercent)
  return (
    <Sheet open={open} onClose={onClose} id="bill-items">
      <div className="px-5 pt-1 pb-[calc(env(safe-area-inset-bottom,0px)+18px)]">
        <p className="text-base font-bold text-text-primary">{title}</p>
        {note && <p className="text-[13px] text-text-secondary mt-0.5">{note}</p>}
        <div className="mt-3 flex flex-col gap-2 text-[14px] tabular-nums">
          {items.map((i, k) => (
            <div key={k} className="flex justify-between gap-3">
              <span className="min-w-0 truncate text-text-secondary">{i.name} × {Number(i.qty)}</span>
              <span className="font-medium text-text-primary">{money(i.total ?? i.qty * i.price)}</span>
            </div>
          ))}
          {b.tax > 0 && <>
            <div className="flex justify-between gap-3 text-text-muted pt-2 border-t border-border"><span>Subtotal</span><span>{money(b.subtotal)}</span></div>
            <div className="flex justify-between gap-3 text-text-muted"><span>Tax ({taxPercent}%)</span><span>+ {money(b.tax)}</span></div>
          </>}
          <div className="flex justify-between gap-3 pt-2 border-t border-border text-[15px] font-bold text-text-primary"><span>Total</span><span>{money(b.total)}</span></div>
        </div>
      </div>
    </Sheet>
  )
}

/** Live status of one request (polls until it's final). */
export function useLiveRequest(code: string | null) {
  const [view, setView] = useState<PaymentView | null>(null)
  useEffect(() => {
    setView(null)
    if (!code) return
    return watchPayment(code, setView, 3000)
  }, [code])
  return view
}

type StatusLike = Pick<PaymentView, 'status' | 'received' | 'amount'>
export function liveStatus(v: StatusLike | null): { status: LiveStatusKind; text: string } {
  const s = v?.status ?? 'pending'
  if (s === 'paid') return { status: 'paid', text: `Paid ${money(v!.received || v!.amount)}` }
  if (s === 'partially_paid') return { status: 'partial', text: `Received ${money(v!.received)} of ${money(v!.amount)}` }
  if (s === 'payment_detected' || s === 'processing') return { status: 'detected', text: 'Payment found - confirming' }
  if (s === 'expired') return { status: 'expired', text: 'This request expired' }
  if (s === 'cancelled') return { status: 'cancelled', text: 'Cancelled' }
  if (s === 'failed') return { status: 'failed', text: 'Payment failed' }
  return { status: 'waiting', text: 'Waiting for payment' }
}
export const Live = ({ view }: { view: StatusLike | null }) => <LiveStatus {...liveStatus(view)} />

/** The saved status (before the live one loads): a pending one past its expiry is expired. */
const savedStatus = (i: MerchantIntent) =>
  i.status === 'pending' && i.expiresAt && !i.dueDate && Date.parse(i.expiresAt) < Date.now() ? 'expired' : i.status

const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`

export function RequestResult({ intent, view, isDesktop, name, username, avatar, sub, from, validLabel,
  sender, onOpenChat, onClose, onCancel, onNew, newLabel = 'New payment', noPerson = false }: {
  intent: MerchantIntent
  view: PaymentView | null
  isDesktop: boolean
  /** Who's paid: the store, or the person. */
  name: string
  username?: string | null
  avatar?: string | null
  sub?: string | null
  /** Who it's from in the shared text ("Royal Salons · Cutting Edge"). */
  from: string
  /** How long it was made for ("15 min"); otherwise its expiry time. */
  validLabel?: string
  /** The chat card being sent to the named customer. */
  sender?: ReturnType<typeof useChatCardSender>
  onOpenChat?: (chatId: string) => void
  onClose?: () => void
  onCancel: () => void
  onNew: () => void
  newLabel?: string
  /** The screen's own title already names who's paid and the order
   *  (Business → Collect payment on a phone): no person row here. */
  noPerson?: boolean
}) {
  const live: StatusLike = view ?? { status: savedStatus(intent), received: intent.received, amount: intent.amount }
  const paid = live.status === 'paid'
  const link = paymentLink(intent.code)
  // Expired or cancelled: nothing left to pay, so no QR to share or order to cancel.
  const ended = !paid && (['expired', 'cancelled', 'failed'].includes(live.status)
    || (!!intent.expiresAt && !intent.dueDate && Date.parse(intent.expiresAt) < Date.now()))
  const qr = useQr(ended ? null : link)
  const bill = intent.kind === 'invoice'
  const num = intent.orderNumber ? displayOrderNumber(intent.orderNumber) : ''
  const d = dueText(intent.dueDate ?? null, !paid)
  const dueShare = dueText(intent.dueDate ?? null, true)
  const valid = intent.expiresAt && !intent.dueDate ? (bill ? '7 days' : validLabel) : 'until paid'
  const tx = view?.payments.find(p => p.txHash)?.txHash
  const paidBy = view?.customerUsername ?? intent.customerUsername
  const { copied, copy } = useShare()
  const [itemsOpen, setItemsOpen] = useState(false)
  // Waiting: laid out like Receive → My QR - the amount and the pay link in
  // two boxes on the card over the QR, the share buttons in one row - so it
  // all fits on a phone without scrolling. Paid / ended keep the big amount.
  const open = !paid && !ended
  const shareText = `${from}: ${bill ? `bill ${num} for` : 'pay'} ${money(intent.amount)}${intent.note ? ` - ${intent.note}` : ''}${dueShare ? ` (${dueShare.text.toLowerCase()})` : ''}. Pay in USDC:`
  // A waiting bill: who it's for goes in the header, its items (and note)
  // open from the amount box.
  const billLine = open && bill && (intent.items?.length ?? 0) > 0
  const forWho = intent.customerUsername ? `${intent.customerUsername.replace(/\.arc$/i, '')}.arc` : null
  // Waiting, the due date goes in the card's caption.
  const extras = (!billLine && (intent.note || intent.customerUsername)) || sender || (!open && d)
  return (
    <div className="flex flex-col min-h-0 flex-1">
      {!noPerson && <div className="px-5 flex-shrink-0" style={{ paddingTop: isDesktop ? 20 : 4, paddingBottom: 4 }}>
        <SheetPerson label={`${bill ? 'Bill' : 'Request'} ${num}${billLine && forWho ? ` · for ${forWho}` : ''}`} name={name} username={username} avatar={avatar} onClose={isDesktop ? onClose : undefined} sub={sub} />
      </div>}
      <div className="flex-1 min-h-0 overflow-y-auto" data-no-drag>
        <div className={`flex flex-col items-center text-center px-5 ${open ? 'pt-0.5 pb-3 gap-2.5' : 'pt-3 pb-4 gap-4'}`}>
          {(!open || extras) && (
            <div>
              {!open && <p className="display text-4xl font-bold tabular-nums text-text-primary">{money(intent.amount)}</p>}
              {open
                ? !billLine && (intent.note || intent.customerUsername) && <p className="text-sm text-text-secondary">{[intent.note, intent.customerUsername && `for ${intent.customerUsername.replace(/\.arc$/i, '')}.arc`].filter(Boolean).join(' · ')}</p>
                : <>
                  {intent.note && <p className="text-sm text-text-secondary mt-1">{intent.note}</p>}
                  {intent.customerUsername && <p className="text-xs text-text-muted mt-1">For {intent.customerUsername.replace(/\.arc$/i, '')}.arc</p>}
                </>}
              {sender && <ChatSentLine status={sender.status} onRetry={sender.retry} onOpen={onOpenChat} className="mt-1.5" />}
              {d && !open && <p className={`inline-flex items-center gap-1 text-xs font-semibold mt-1 ${dueTone[d.tone]}`}><CalendarClock className="size-3.5" /> {d.text}</p>}
            </div>
          )}
          {billLine && <BillItemsSheet open={itemsOpen} onClose={() => setItemsOpen(false)} items={intent.items!} taxPercent={intent.taxPercent} note={intent.note} title={`Bill ${num}`} />}
          {bill && !open && (intent.items?.length ?? 0) > 0 && (
            <div className="w-full text-left"><DetailList rows={intent.items!.map(i => ({ label: `${i.name} × ${i.qty}`, value: money(i.total ?? i.qty * i.price) }))} /></div>
          )}
          {open && <QrCard dataUrl={qr} // The live status is the caption (no separate pill - room for the share row).
            caption={<LiveStatus {...liveStatus(live)} inline text={`${liveStatus(live).text} · ${d ? d.text[0].toLowerCase() + d.text.slice(1) : `valid ${valid ?? 'until it expires'}`}`} />}
            top={<div className="w-full flex gap-2">
              {billLine
                ? <QrInfoBox label={`${intent.items!.length} item${intent.items!.length === 1 ? '' : 's'}${intent.note ? ` · ${intent.note}` : ''}`} value={money(intent.amount)} mono={false} onOpen={() => setItemsOpen(true)} />
                : <QrInfoBox label={bill ? 'Bill amount' : 'Amount'} value={money(intent.amount)} mono={false} />}
              <QrInfoBox label="Pay link" value={copied ? 'Copied' : 'Tap to copy'} mono={false} onCopy={() => void copy(link)} copied={copied} />
            </div>} />}
          {paid && <QrCard dataUrl={qr} paid title={name} subtitle={`${bill ? 'Bill' : 'Request'} ${num}`} />}
          {!open && <Live view={live} />}
          {paid && (paidBy || tx) && (
            <div className="w-full text-left"><DetailList rows={[
              ...(paidBy ? [{ label: 'Paid by', value: `${paidBy.replace(/\.arc$/i, '')}.arc` }] : []),
              ...(tx ? [{ label: 'Transaction', value: short(tx) }] : []),
            ]} /></div>
          )}
          {open && <ShareRow url={link} text={shareText} subject={`${from}: ${bill ? 'bill' : 'payment'} ${num} for ${money(intent.amount)}`} />}
        </div>
      </div>
      <div className="px-5 flex-shrink-0" style={{ borderTop: '1px solid var(--border)', paddingTop: 10, paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 18px)' }}>
        {paid || ended ? (
          <button type="button" onClick={onNew}
            className="w-full rounded-2xl text-[16px] font-bold text-white active:scale-[0.98] transition-transform" style={{ height: 52, background: 'var(--brand)' }}>
            {newLabel}
          </button>
        ) : (
          <button type="button" onClick={onCancel}
            className="w-full rounded-2xl text-[15px] font-semibold active:scale-[0.98] transition-transform"
            style={{ height: 52, background: 'color-mix(in srgb, var(--text-primary) 7%, transparent)', border: '1px solid color-mix(in srgb, var(--text-primary) 10%, transparent)', color: 'var(--text-secondary)' }}>
            {bill ? 'Cancel bill' : 'Cancel payment'}
          </button>
        )}
      </div>
    </div>
  )
}
