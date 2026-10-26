/**
 * Cash-out to bank (INR) components:
 * CashOutAmountCard, CashOutPickRow, BuyerList, PayoutAccountList,
 * PayoutAccountForm, CashOutTracker, CashOutChat, CashOutHistoryList.
 * Presentational only: CashOutScreen (../cashOutScreen.tsx) feeds them data.
 */
import React from 'react'
import { ShieldCheck, Loader2, Send, AlertTriangle, Plus, Landmark, UserRound, Check, ChevronRight, X, Clock } from 'lucide-react'
import { Skeleton } from './primitives'
import { AmountField, type QuickAmount } from '@/components/ui/AmountField'

// ─── CashOutAmountCard ────────────────────────────────────────────────────────

export interface CashOutAmountCardProps {
  value: string
  onChange: (v: string) => void
  available: string           // "$2,310.40"
  /** Quick amounts under the field ($100 / $500 / $1,000), greyed out above what can go. */
  quick: QuickAmount[]
  onMax?: () => void
  fiat: string                // "₹41,700" or ''
  rate?: string               // "₹83.40 / $"
  error?: string
  /** Phone: tapping the field opens the AmountKeypad sheet (`editing` while it's up). */
  onTap?: () => void
  editing?: boolean
}

/** The amount box is the app's one AmountField (Pay, Swap, Bulk Pay…); the
 *  bank side (what arrives in rupees, at what rate) sits under it. */
export function CashOutAmountCard({ value, onChange, available, quick, onMax, fiat, rate, error, onTap, editing }: CashOutAmountCardProps) {
  return (
    <div className="rounded-3xl bg-card border border-border p-5 flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="text-xs text-text-muted">Available {available}</p>
        <AmountField value={value} onChange={onChange} ariaLabel="Amount in dollars" autoFocus={false}
          token={{ label: 'USDC', logo: '/logos/tokens/usdc.png' }} quick={quick} onMax={onMax}
          invalid={!!error} onTap={onTap} editing={editing} />
      </div>
      <div className="flex items-center justify-between gap-3 pt-3.5 border-t border-dashed border-border">
        {error ? (
          <p className="text-xs font-semibold text-danger">{error}</p>
        ) : (
          <div className="min-w-0">
            <p className="text-xs text-text-muted">You get in your bank</p>
            <p className={`text-[22px] font-bold tabular-nums ${fiat ? 'text-success' : 'text-text-muted'}`}>{fiat || '₹0'}</p>
          </div>
        )}
        {rate && <span className="shrink-0 px-2.5 py-1 rounded-full bg-success/12 text-success text-[11px] font-semibold tabular-nums">{rate}</span>}
      </div>
    </div>
  )
}

// ─── CashOutPickRow (buyer / account rows in one card) ───────────────────────

export interface CashOutPickRowProps {
  icon: 'buyer' | 'bank'
  title: string
  subtitle: string
  action?: string             // "Change"
  onClick: () => void
  loading?: boolean
}

export function CashOutPickRow({ icon, title, subtitle, action, onClick, loading }: CashOutPickRowProps) {
  const Icon = icon === 'buyer' ? UserRound : Landmark
  return (
    <button type="button" onClick={onClick} className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-border/20">
      <span className="shrink-0 size-9 rounded-xl bg-brand/10 text-brand-text inline-flex items-center justify-center"><Icon className="size-[18px]" /></span>
      {loading ? (
        <span className="flex-1 flex flex-col gap-1.5"><Skeleton className="h-3.5 w-32 rounded" /><Skeleton className="h-3 w-44 rounded" /></span>
      ) : (
        <span className="flex-1 min-w-0">
          <span className="block text-[14px] font-semibold text-text-primary truncate">{title}</span>
          <span className="block text-xs text-text-muted truncate">{subtitle}</span>
        </span>
      )}
      {action ? <span className="shrink-0 text-xs font-semibold text-brand-text">{action}</span> : <ChevronRight className="shrink-0 size-4 text-text-muted" />}
    </button>
  )
}

// ─── BuyerList (inside the Change buyer sheet) ───────────────────────────────

export interface BuyerOption {
  id: string
  name: string
  verified: boolean
  detail: string              // "★ 4.9 · UPI, IMPS"
  youGet: string              // "₹41,700" ('' when this buyer can't take the amount)
  rate: string                // "₹83.40 / $"
  note?: string               // "Takes $10 – $300"
  best?: boolean
  disabled?: boolean
}

export function BuyerList({ buyers, selected, onSelect }: { buyers: BuyerOption[]; selected?: string; onSelect: (id: string) => void }) {
  return (
    <div className="flex flex-col">
      {buyers.map(b => (
        <button key={b.id} type="button" disabled={b.disabled} onClick={() => onSelect(b.id)}
          className={`flex items-center gap-3 px-5 py-3 text-left transition-colors disabled:opacity-50 ${selected === b.id ? 'bg-brand/10' : 'active:bg-border/20'}`}>
          <span className={`shrink-0 size-[18px] rounded-full border-2 ${selected === b.id ? 'border-[5px] border-brand-text' : 'border-border'}`} />
          <span className="flex-1 min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="text-[14px] font-semibold text-text-primary truncate">{b.name}</span>
              {b.verified && <ShieldCheck className="size-3.5 text-success shrink-0" />}
              {b.best && <span className="px-1.5 py-0.5 rounded-full bg-success/12 text-success text-[11px] font-bold">Best</span>}
            </span>
            <span className="block text-xs text-text-muted truncate">{b.note || b.detail}</span>
          </span>
          <span className="shrink-0 text-right">
            <span className="block text-[14px] font-bold tabular-nums text-text-primary">{b.youGet || '—'}</span>
            <span className="block text-[11px] text-text-muted tabular-nums">{b.rate}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

// ─── PayoutAccountList (inside the Get paid to sheet) ────────────────────────

export interface PayoutAccount { id: string; method: string; summary: string; holder?: string }

export function PayoutAccountList({ accounts, selected, onSelect, onAdd }: {
  accounts: PayoutAccount[]; selected?: string; onSelect: (id: string) => void; onAdd: () => void
}) {
  return (
    <div className="flex flex-col">
      {accounts.map(a => (
        <button key={a.id} type="button" onClick={() => onSelect(a.id)}
          className={`flex items-center gap-3 px-5 py-3 text-left ${selected === a.id ? 'bg-brand/10' : 'active:bg-border/20'}`}>
          <span className="shrink-0 size-9 rounded-xl bg-brand/10 text-brand-text inline-flex items-center justify-center"><Landmark className="size-[18px]" /></span>
          <span className="flex-1 min-w-0">
            <span className="block text-[14px] font-semibold text-text-primary truncate">{a.summary}</span>
            <span className="block text-xs text-text-muted truncate">{a.holder || a.method}</span>
          </span>
          {selected === a.id && <Check className="shrink-0 size-4 text-brand-text" strokeWidth={3} />}
        </button>
      ))}
      <button type="button" onClick={onAdd} className="flex items-center gap-3 px-5 py-3 text-left text-brand-text active:bg-border/20">
        <span className="shrink-0 size-9 rounded-xl border border-dashed border-border inline-flex items-center justify-center"><Plus className="size-4" /></span>
        <span className="text-[14px] font-semibold">Add UPI or bank account</span>
      </button>
    </div>
  )
}

// ─── PayoutAccountForm ────────────────────────────────────────────────────────

export type PayoutMethod = 'UPI' | 'Bank transfer'

export interface PayoutAccountField { key: string; label: string; value: string; placeholder: string }

export interface PayoutAccountFormProps {
  method: PayoutMethod
  onMethod: (m: PayoutMethod) => void
  holder: string
  onHolder: (v: string) => void
  fields: PayoutAccountField[]
  onField: (key: string, v: string) => void
  busy?: boolean
  onSave: () => void
  onCancel: () => void
}

const inputCls = 'h-12 px-4 rounded-2xl bg-card border border-border text-text-primary text-sm placeholder:text-text-muted focus:outline-none focus:border-brand-text'

export function PayoutAccountForm({ method, onMethod, holder, onHolder, fields, onField, busy, onSave, onCancel }: PayoutAccountFormProps) {
  return (
    <div className="flex flex-col gap-4 px-5">
      <div className="grid grid-cols-2 gap-1 bg-bg border border-border rounded-2xl p-1">
        {(['UPI', 'Bank transfer'] as PayoutMethod[]).map(m => (
          <button key={m} type="button" onClick={() => onMethod(m)}
            className={`h-9 rounded-xl text-sm font-semibold transition-colors ${method === m ? 'bg-brand text-white' : 'text-text-secondary'}`}>
            {m}
          </button>
        ))}
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-text-secondary">Name on the account</span>
        <input type="text" value={holder} onChange={e => onHolder(e.target.value)} placeholder="Full name as in your bank" className={inputCls} />
      </label>
      {fields.map(f => (
        <label key={f.key} className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-text-secondary">{f.label}</span>
          <input type="text" value={f.value} onChange={e => onField(f.key, e.target.value)} placeholder={f.placeholder}
            autoCapitalize="none" autoCorrect="off" spellCheck={false} className={inputCls} />
        </label>
      ))}
      <div className="flex gap-3 pt-1">
        <button type="button" onClick={onCancel} className="flex-1 h-12 rounded-2xl border border-border text-text-secondary text-sm font-semibold">Back</button>
        <button type="button" onClick={onSave} disabled={busy}
          className="flex-1 h-12 rounded-2xl bg-brand text-white font-semibold text-sm disabled:opacity-60 inline-flex items-center justify-center gap-2">
          {busy && <Loader2 className="size-4 animate-spin" />} Save account
        </button>
      </div>
    </div>
  )
}

// ─── CashOutTracker ───────────────────────────────────────────────────────────

export type TradeStage = 'escrow' | 'waiting_payment' | 'payment_sent' | 'released' | 'cancelled' | 'disputed'

export interface CashOutTrackerProps {
  amountUsdc: string          // "$500.00"
  amountFiat: string          // "₹41,700"
  buyer: string
  account: string             // "UPI · sunil@okaxis"
  stage: TradeStage
  lockedAt: string            // "4:02 pm"
  paidAt?: string             // "4:09 pm"
  countdown?: string          // "14:32"
  cancelReason?: string
}

const STEP_INDEX: Record<TradeStage, number> = { escrow: 0, waiting_payment: 1, payment_sent: 2, released: 4, cancelled: -1, disputed: -1 }

export function CashOutTracker({ amountUsdc, amountFiat, buyer, account, stage, lockedAt, paidAt, countdown, cancelReason }: CashOutTrackerProps) {
  const at = STEP_INDEX[stage]
  const steps = [
    { title: `${amountUsdc} locked safely`, detail: `Held in escrow · ${lockedAt}` },
    { title: at > 1 ? `${buyer} sent ${amountFiat}` : `${buyer} is paying you`, detail: at > 1 ? (paidAt ? `Marked paid · ${paidAt}` : 'Marked paid') : countdown ? `They have ${countdown} to send ${amountFiat}` : `Waiting for ${amountFiat}` },
    { title: 'Check your bank', detail: at === 2 ? `Open your bank app and find ${amountFiat} from ${buyer}` : "We'll tell you when they mark it paid" },
    { title: 'Release and done', detail: at >= 4 ? `${amountUsdc} went to ${buyer}` : `The ${amountUsdc} goes to the buyer` },
  ]
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-center gap-1 text-center pt-2">
        {stage === 'payment_sent' && <span className="mb-1 px-2.5 py-0.5 rounded-full bg-warning/12 text-warning text-[11px] font-semibold">Action needed</span>}
        {stage === 'released' && <span className="mb-1 px-2.5 py-0.5 rounded-full bg-success/12 text-success text-[11px] font-semibold">Done</span>}
        {stage === 'cancelled' && <span className="mb-1 px-2.5 py-0.5 rounded-full bg-bg border border-border text-text-secondary text-[11px] font-semibold">Cancelled</span>}
        {stage === 'disputed' && <span className="mb-1 px-2.5 py-0.5 rounded-full bg-danger/10 text-danger text-[11px] font-semibold">Under review</span>}
        <p className="text-xs text-text-muted">{stage === 'released' ? 'You got' : 'You get'}</p>
        <p className="text-[34px] leading-tight font-bold tabular-nums text-text-primary">{amountFiat}</p>
        <p className="text-xs text-text-secondary">for {amountUsdc} · to {account}</p>
      </div>
      {at >= 0 ? (
        <ol className="rounded-2xl bg-card border border-border px-4 py-2">
          {steps.map((s, i) => {
            const done = i < at || at >= 4
            const now = i === at
            return (
              <li key={i} className="relative grid grid-cols-[22px_1fr] gap-3 py-2.5">
                {i < steps.length - 1 && <span className={`absolute left-[10px] top-[34px] -bottom-[10px] w-0.5 ${done ? 'bg-success' : 'bg-border'}`} />}
                <span className={`relative size-[22px] rounded-full inline-flex items-center justify-center text-[11px] font-bold ${
                  done ? 'bg-success text-white' : now ? 'bg-brand text-white ring-4 ring-brand/20' : 'border-2 border-border text-text-muted bg-card'}`}>
                  {done ? <Check className="size-3" strokeWidth={3.5} /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span className={`block text-[13px] font-semibold ${done || now ? 'text-text-primary' : 'text-text-muted'}`}>{s.title}</span>
                  <span className="block text-xs text-text-secondary">{s.detail}</span>
                </span>
              </li>
            )
          })}
        </ol>
      ) : (
        <div className="rounded-2xl bg-card border border-border p-4 text-sm text-text-secondary">
          {stage === 'cancelled'
            ? <>This cash out was cancelled{cancelReason ? ` (${cancelReason.replace(/\.$/, '')})` : ''}. Your {amountUsdc} is back in your balance.</>
            : <>MeshPort is reviewing this cash out. Your {amountUsdc} stays locked until it's sorted, and you'll get a notification.</>}
        </div>
      )}
      {stage === 'waiting_payment' && (
        <div className="flex gap-2.5 rounded-2xl bg-card border border-border p-3.5 text-xs text-text-secondary">
          <Clock className="size-4 text-brand-text shrink-0" /> If they don't pay in time, the {amountUsdc} comes back to you automatically.
        </div>
      )}
      {stage === 'payment_sent' && (
        <div className="flex gap-2.5 rounded-2xl bg-warning/10 border border-warning/30 p-3.5 text-xs text-warning">
          <AlertTriangle className="size-4 shrink-0" /> Release only after {amountFiat} is in your bank. Never release for a screenshot.
        </div>
      )}
    </div>
  )
}

// ─── CashOutChat ──────────────────────────────────────────────────────────────

export interface TradeMessage { id: string; mine: boolean; system?: boolean; text: string; time: string }

export function CashOutChat({ messages, draft, onDraft, onSend, onClose }: {
  messages: TradeMessage[]; draft: string; onDraft: (v: string) => void; onSend: () => void; onClose: () => void
}) {
  const end = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [messages.length])
  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex items-center justify-between px-5 pb-2">
        <p className="text-base font-semibold text-text-primary">Chat with buyer</p>
        <button type="button" aria-label="Close chat" onClick={onClose} className="size-9 inline-flex items-center justify-center rounded-xl text-text-muted"><X className="size-4.5" /></button>
      </div>
      <div className="flex-1 min-h-[200px] overflow-y-auto px-5 flex flex-col gap-2 pb-3">
        {messages.length === 0 && <p className="text-xs text-text-muted text-center py-8">No messages yet. Messages here are kept with this cash out.</p>}
        {messages.map(m => (
          <div key={m.id} className={`flex ${m.system ? 'justify-center' : m.mine ? 'justify-end' : 'justify-start'}`}>
            {m.system ? (
              <span className="text-[11px] text-text-muted px-3 py-1 rounded-full bg-card border border-border text-center">{m.text}</span>
            ) : (
              <div className={`max-w-[78%] px-3.5 py-2 rounded-2xl ${m.mine ? 'bg-brand text-white rounded-br-md' : 'bg-card border border-border text-text-primary rounded-bl-md'}`}>
                <p className="text-sm break-words">{m.text}</p>
                <p className={`text-[11px] mt-0.5 ${m.mine ? 'text-white/70' : 'text-text-muted'}`}>{m.time}</p>
              </div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="flex gap-2 px-5 pt-2 pb-5 border-t border-border">
        <input type="text" value={draft} onChange={e => onDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && onSend()}
          placeholder="Message the buyer…" aria-label="Message the buyer"
          className="flex-1 h-11 px-4 rounded-2xl bg-card border border-border text-text-primary text-sm ![font-size:max(var(--fs-field,0px),0.875rem)] placeholder:text-text-muted focus:outline-none focus:border-brand-text" />
        <button type="button" aria-label="Send message" onClick={onSend} disabled={!draft.trim()}
          className="size-11 rounded-2xl bg-brand text-white inline-flex items-center justify-center disabled:opacity-40">
          <Send className="size-4" />
        </button>
      </div>
    </div>
  )
}

// ─── CashOutHistoryList ───────────────────────────────────────────────────────

export type CashOutHistoryStatus = 'active' | 'action' | 'completed' | 'cancelled' | 'disputed'

export interface CashOutHistoryItem {
  id: string
  amountFiat: string
  detail: string              // "$500 · Rahul Traders · 18 Oct"
  status: CashOutHistoryStatus
}

const STATUS_STYLE: Record<CashOutHistoryStatus, string> = {
  active: 'bg-brand/10 text-brand-text', action: 'bg-warning/12 text-warning', completed: 'bg-success/12 text-success',
  cancelled: 'bg-bg border border-border text-text-secondary', disputed: 'bg-danger/10 text-danger',
}
const STATUS_LABEL: Record<CashOutHistoryStatus, string> = {
  active: 'In progress', action: 'Check bank', completed: 'Done', cancelled: 'Cancelled', disputed: 'Under review',
}

export function CashOutHistoryList({ items, onOpen }: { items: CashOutHistoryItem[]; onOpen: (id: string) => void }) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center">
        <span className="size-12 rounded-full bg-brand/10 text-brand-text inline-flex items-center justify-center"><Landmark className="size-5" /></span>
        <p className="text-sm font-semibold text-text-primary">No cash outs yet</p>
        <p className="text-xs text-text-muted max-w-[250px]">When you cash out to your bank, each one shows here with where it's up to.</p>
      </div>
    )
  }
  return (
    <div className="rounded-2xl bg-card border border-border divide-y divide-border">
      {items.map(it => (
        <button key={it.id} type="button" onClick={() => onOpen(it.id)} className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-border/20">
          <span className="flex-1 min-w-0">
            <span className={`block text-[14px] font-semibold tabular-nums ${it.status === 'cancelled' ? 'text-text-secondary' : 'text-text-primary'}`}>{it.amountFiat}</span>
            <span className="block text-xs text-text-muted truncate">{it.detail}</span>
          </span>
          <span className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold ${STATUS_STYLE[it.status]}`}>{STATUS_LABEL[it.status]}</span>
        </button>
      ))}
    </div>
  )
}
