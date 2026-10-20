// Receive → Request (every user; a business's too). The same form and screen
// as Business → Collect payment → Request: amount (keypad + quick amounts),
// note, how long it's valid and optionally who it's for, then the request's
// QR, live status and a link to send (RequestResult). Every request is an
// order (unique #N): its QR and link open it in MeshPort (amount and number
// fixed) or in a wallet app's browser on Arc.
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store'
import { formatAmount } from '@/lib/utils'
import { createPaymentRequest, cancelPayment, paymentRequestMessage, shopFrom, type MerchantIntent } from '@/lib/merchantPay'
import { SheetPerson, SheetLabel, SheetChips } from '@/components/ui/ActionSheet'
import { UserPicker, exactPick, pickerProblem, type PickedUser } from '@/components/ui/UserPicker'
import { useChatCardSender } from '@/hooks/useChatCardSender'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { RequestAmountForm } from '@/features/merchant/RequestComposer'
import { RequestResult, OPEN, VALID_FOR, useLiveRequest, type ValidFor } from '@/features/merchant/RequestResult'
import type { DbUser } from '@/lib/supabase'

const EXPIRY = [{ label: '15 min', min: 15 }, { label: '1 hour', min: 60 }, { label: '24 hours', min: 1440 }, { label: 'No expiry', min: 0 }]

/** Expiry chips - Merchant QR's amount QR still uses these. */
export function ExpiryChips({ value, onChange }: { value: number; onChange: (m: number) => void }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {EXPIRY.map(x => (
        <button key={x.min} type="button" onClick={() => onChange(x.min)}
          style={{ padding: '6px 11px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid var(--border)',
            background: value === x.min ? 'var(--brand)' : 'transparent', color: value === x.min ? '#fff' : 'var(--text-secondary)' }}>{x.label}</button>
      ))}
    </div>
  )
}

/** "@Priya.arc " → "priya". */
const cleanUsername = (v: string) => v.trim().replace(/^@/, '').replace(/\.arc$/i, '').toLowerCase()

export function RequestQrPanel({ initialCustomer, initialOrder, onClose, onNewRequest }: {
  /** A username to request from (?customer=). */
  initialCustomer?: string
  /** Open straight on an existing request (Receive → My requests). */
  initialOrder?: MerchantIntent
  /** Desktop: the ✕ in the header. */
  onClose?: () => void
  /** "New request" goes here instead of clearing to the form (My requests). */
  onNewRequest?: () => void
}) {
  const navigate = useNavigate()
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const user = useAuthStore(s => s.user)
  const handle = useAuthStore(s => s.username)?.replace(/\.arc$/i, '') ?? null
  const [intent, setIntent] = useState<MerchantIntent | null>(initialOrder ?? null)
  const view = useLiveRequest(intent?.code ?? null)
  const [expiry, setExpiry] = useState<ValidFor>('60')
  const [customerQuery, setCustomerQuery] = useState(() => initialCustomer ? cleanUsername(initialCustomer) : '')
  const [picked, setPicked] = useState<PickedUser | null>(null)
  const [found, setFound] = useState<{ results: DbUser[]; searching: boolean }>({ results: [], searching: false })
  // With a person named, the request's card goes into your chat with them.
  const sender = useChatCardSender()

  const name = view?.merchantName || user?.displayName || (handle ? `${handle}.arc` : 'You')
  const validLabel = VALID_FOR.find(v => v.id === expiry)?.label ?? '1 hour'
  const who = picked ? cleanUsername(picked.username) : cleanUsername(customerQuery)

  /** The person: the one picked, or the exact username typed. */
  const resolveCustomer = (): PickedUser | null => {
    if (picked) return picked
    if (!customerQuery.trim()) return null
    const exact = exactPick(customerQuery, found.results)
    if (exact) { const u = { id: exact.id, username: cleanUsername(exact.username), display_name: exact.display_name, avatar_url: exact.avatar_url }; setPicked(u); setCustomerQuery(''); return u }
    if (found.searching) throw new Error('Still looking up that username - try again')
    throw new Error(pickerProblem(customerQuery, { searching: false, found: 0, self: false })?.text ?? 'Pick a MeshPort user')
  }
  const create = async (amount: number, note: string) => {
    const person = resolveCustomer()
    const it = await createPaymentRequest({ amount, note: note || undefined, customer: person ? cleanUsername(person.username) : undefined, expiresInMinutes: Number(expiry) || null })
    if (person) void sender.send({ id: person.id, name: person.display_name || `${cleanUsername(person.username)}.arc` }, paymentRequestMessage(it, formatAmount(it.amount)))
    else sender.reset()
    setIntent(it)
  }
  const cancel = async () => {
    if (intent && (!view || OPEN.has(view.status))) await cancelPayment(intent.code).catch(() => {})
    // From My requests it stays open (now Cancelled); a new one goes back to the form.
    if (!initialOrder) { setIntent(null); sender.reset() }
  }
  const newRequest = () => {
    sender.reset()
    if (onNewRequest) { onNewRequest(); return }
    setIntent(null)
  }

  if (intent) {
    return (
      <RequestResult intent={intent} view={view} isDesktop={isDesktop} name={name} username={handle} avatar={user?.avatar}
        from={view ? shopFrom(view.merchantName, view.storeName) : name} payer="They're" validLabel={intent === initialOrder ? undefined : validLabel}
        sender={sender} onOpenChat={id => navigate(`/chat/${id}`)} onClose={onClose} onCancel={() => void cancel()} onNew={newRequest} newLabel="New request" />
    )
  }
  return (
    <RequestAmountForm open={!intent} isDesktop={isDesktop} verb="Request" busyText="Creating…" places={2}
      ariaLabel="Amount to request in USDC" hint="They scan the QR or open the link"
      header={compact => <SheetPerson label="Paid to" name={name} username={handle} avatar={user?.avatar} compact={compact} onClose={isDesktop ? onClose : undefined} />}
      options={{
        summary: <>Valid for <b className="font-semibold text-text-primary">{validLabel}</b>{who
          ? <> · from <b className="font-semibold text-text-primary">{who}.arc</b></>
          : <> · anyone</>}</>,
        panel: <>
          <div><SheetLabel>Valid for</SheetLabel><SheetChips<ValidFor> label="Valid for" options={VALID_FOR} value={expiry} onChange={setExpiry} /></div>
          <UserPicker label="Request from (optional)" hint="A MeshPort user - the request goes into your chat with them." query={customerQuery} onQuery={setCustomerQuery}
            picked={picked} onPick={setPicked} onResults={(results, searching) => setFound({ results, searching })} />
        </>,
      }}
      onSubmit={create} />
  )
}
