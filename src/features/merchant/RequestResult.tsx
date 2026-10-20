// One payment request (or bill) after it's made: the amount, a counter QR, its
// live status and a link to send, then Cancel / New. Business → Collect
// payment and Receive → Request show this same screen, so a request looks and
// works the same for a shop and a person.
import { useEffect, useState } from 'react'
import { CalendarClock } from 'lucide-react'
import { useUIStore } from '@/store'
import { drawMeshportQr } from '@/lib/qrLogo'
import { paymentLink, watchPayment, displayOrderNumber, type MerchantIntent, type PaymentView } from '@/lib/merchantPay'
import { dueText } from '@/lib/businessBills'
import { SheetPerson } from '@/components/ui/ActionSheet'
import { ChatSentLine } from '@/components/ui/ChatSentLine'
import type { useChatCardSender } from '@/hooks/useChatCardSender'
import { QrCard } from '@/features/business/ui/QrCard'
import { LiveStatus, type LiveStatusKind } from '@/features/business/ui/LiveStatus'
import { ShareLink } from '@/features/business/ui/ShareLink'
import { DetailList } from '@/features/business/ui/ProfileCards'

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

export function RequestResult({ intent, view, isDesktop, name, username, avatar, sub, from, payer = 'Customer', validLabel,
  sender, onOpenChat, onClose, onCancel, onNew, newLabel = 'New payment' }: {
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
  /** "Customer" / "Client"…: "<payer> not here? Send the link". */
  payer?: string
  /** How long it was made for ("15 min"); otherwise its expiry time. */
  validLabel?: string
  /** The chat card being sent to the named customer. */
  sender?: ReturnType<typeof useChatCardSender>
  onOpenChat?: (chatId: string) => void
  onClose?: () => void
  onCancel: () => void
  onNew: () => void
  newLabel?: string
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
  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="px-5 flex-shrink-0" style={{ paddingTop: isDesktop ? 20 : 4, paddingBottom: 4 }}>
        <SheetPerson label={bill ? `Bill ${num}` : `Request ${num}`} name={name} username={username} avatar={avatar} onClose={isDesktop ? onClose : undefined} sub={sub} />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto" data-no-drag>
        <div className="flex flex-col items-center text-center px-5 pt-3 pb-4 gap-4">
          <div>
            <p className="display text-4xl font-bold tabular-nums text-text-primary">{money(intent.amount)}</p>
            {intent.note && <p className="text-sm text-text-secondary mt-1">{intent.note}</p>}
            {intent.customerUsername && <p className="text-xs text-text-muted mt-1">For {intent.customerUsername.replace(/\.arc$/i, '')}.arc</p>}
            {sender && <ChatSentLine status={sender.status} onRetry={sender.retry} onOpen={onOpenChat} className="mt-1.5" />}
            {d && <p className={`inline-flex items-center gap-1 text-xs font-semibold mt-1 ${dueTone[d.tone]}`}><CalendarClock className="size-3.5" /> {d.text}</p>}
          </div>
          {bill && (intent.items?.length ?? 0) > 0 && (
            <div className="w-full text-left"><DetailList rows={intent.items!.map(i => ({ label: `${i.name} × ${i.qty}`, value: money(i.total ?? i.qty * i.price) }))} /></div>
          )}
          {!ended && <QrCard dataUrl={qr} paid={paid} title={name} subtitle={`${bill ? 'Bill' : 'Request'} ${num}${paid ? '' : ` · valid ${valid ?? 'until it expires'}`}`} caption="Scan to pay - the amount is fixed" />}
          <Live view={live} />
          {paid && (paidBy || tx) && (
            <div className="w-full text-left"><DetailList rows={[
              ...(paidBy ? [{ label: 'Paid by', value: `${paidBy.replace(/\.arc$/i, '')}.arc` }] : []),
              ...(tx ? [{ label: 'Transaction', value: short(tx) }] : []),
            ]} /></div>
          )}
          {!paid && !ended && (
            <div className="w-full text-left">
              <p className="text-xs text-text-muted mb-2">{payer} not here? Send the link</p>
              <LinkShare url={link} subject={`${from}: ${bill ? 'bill' : 'payment'} ${num} for ${money(intent.amount)}`}
                text={`${from}: ${bill ? `bill ${num} for` : 'pay'} ${money(intent.amount)}${intent.note ? ` - ${intent.note}` : ''}${dueShare ? ` (${dueShare.text.toLowerCase()})` : ''}. Pay in USDC:`} />
            </div>
          )}
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
            Cancel payment
          </button>
        )}
      </div>
    </div>
  )
}
