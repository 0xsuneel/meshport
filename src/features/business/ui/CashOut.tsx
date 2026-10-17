/**
 * Cash-out to bank (INR) components:
 * CashOutHero, CashOutAmount, BuyerOfferList,
 * PayoutAccountPicker, PayoutAccountForm, CashOutTradeView, CashOutHistory.
 */
import React from 'react'
import { ShieldCheck, Loader2, Send, AlertTriangle, Plus, CreditCard } from 'lucide-react'
import { Skeleton, Divider } from './primitives'
import { motion, AnimatePresence } from 'framer-motion'

// ─── CashOutHero ─────────────────────────────────────────────────────────────

export interface CashOutHeroProps {
  usdc: string        // "$158.89"
  estimate: string    // "≈ ₹13,250"
  rateLabel: string   // "Best rate ₹83.40 / USDC"
}

export function CashOutHero({ usdc, estimate, rateLabel }: CashOutHeroProps) {
  return (
    <div className="bg-card border border-border/50 rounded-3xl px-6 py-7 flex flex-col items-center gap-1 text-center">
      <p className="text-xs text-text-muted font-medium uppercase tracking-wide mb-2">
        Available to cash out
      </p>
      <p className="text-4xl font-bold tabular-nums text-text-primary">{usdc}</p>
      <p className="text-xl font-semibold tabular-nums text-text-secondary">{estimate}</p>
      <span className="mt-3 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-success/10 text-success text-xs font-medium">
        <ShieldCheck className="size-3.5" />
        {rateLabel}
      </span>
    </div>
  )
}

// ─── CashOutAmount ────────────────────────────────────────────────────────────

export interface CashOutAmountProps {
  value: string
  onChange: (v: string) => void
  max: string
  onMax: () => void
  estimate: string
  error?: string
}

export function CashOutAmount({ value, onChange, max, onMax, estimate, error }: CashOutAmountProps) {
  return (
    <div className="bg-card border border-border/50 rounded-3xl p-5 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-bold text-text-secondary">$</span>
            <input
              type="number"
              inputMode="decimal"
              value={value}
              onChange={e => onChange(e.target.value)}
              placeholder="0.00"
              className="flex-1 bg-transparent text-3xl font-bold tabular-nums text-text-primary placeholder-text-muted focus:outline-none w-full"
            />
          </div>
          <div className="mt-0.5 h-px bg-border" />
        </div>
        <button
          type="button"
          onClick={onMax}
          className="shrink-0 h-8 px-3 rounded-full bg-brand/10 text-brand-text text-xs font-semibold"
        >
          MAX
        </button>
      </div>
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : (
        <p className="text-sm text-text-muted tabular-nums">
          {estimate} <span className="text-text-muted opacity-60">· Max {max}</span>
        </p>
      )}
    </div>
  )
}

// ─── BuyerOfferList ───────────────────────────────────────────────────────────

export interface BuyerOffer {
  id: string
  name: string
  verified: boolean
  rating: string        // "4.9 · 120 trades"
  price: string         // "₹83.40"
  limits: string        // "₹500 – ₹50,000"
  methods: string[]
  best?: boolean
}

export interface BuyerOfferListProps {
  loading?: boolean
  offers: BuyerOffer[]
  selected?: string
  onSelect: (id: string) => void
}

export function BuyerOfferList({ loading, offers, selected, onSelect }: BuyerOfferListProps) {
  if (loading) {
    return (
      <div className="flex flex-col gap-3 px-5">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-card rounded-2xl p-4 flex gap-3">
            <Skeleton className="size-10 rounded-full" />
            <div className="flex-1 flex flex-col gap-2">
              <Skeleton className="h-4 w-28 rounded" />
              <Skeleton className="h-3 w-20 rounded" />
            </div>
            <Skeleton className="h-8 w-20 rounded-xl" />
          </div>
        ))}
      </div>
    )
  }

  if (offers.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center px-8">
        <p className="text-text-secondary font-medium">No buyers right now</p>
        <p className="text-sm text-text-muted">Check back in a few minutes. Buyers are usually available during business hours.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 px-5">
      {offers.map(offer => (
        <button
          key={offer.id}
          type="button"
          onClick={() => onSelect(offer.id)}
          className={[
            'bg-card rounded-2xl p-4 flex items-start gap-3 text-left transition-all border',
            selected === offer.id ? 'border-brand ring-1 ring-brand/30' : 'border-border/50',
          ].join(' ')}
        >
          {/* Avatar initial */}
          <span className="size-10 rounded-full bg-brand/10 text-brand-text text-sm font-bold flex items-center justify-center shrink-0">
            {offer.name[0].toUpperCase()}
          </span>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="text-sm font-semibold text-text-primary truncate">{offer.name}</span>
              {offer.verified && <ShieldCheck className="size-3.5 text-success shrink-0" />}
              {offer.best && (
                <span className="px-1.5 py-0.5 rounded bg-success/10 text-success text-[10px] font-bold uppercase tracking-wide">
                  Best rate
                </span>
              )}
            </div>
            <p className="text-xs text-text-muted">{offer.rating}</p>
            <p className="text-xs text-text-muted mt-1">{offer.limits}</p>
            <div className="flex flex-wrap gap-1 mt-1.5">
              {offer.methods.map(m => (
                <span key={m} className="px-2 py-0.5 rounded-full bg-surface border border-border text-[11px] text-text-secondary">
                  {m}
                </span>
              ))}
            </div>
          </div>

          <p className="text-base font-bold tabular-nums text-text-primary shrink-0">{offer.price}</p>
        </button>
      ))}
    </div>
  )
}

// ─── PayoutAccountPicker ──────────────────────────────────────────────────────

export interface PayoutAccount {
  id: string
  method: string
  summary: string   // "UPI · sunil@okaxis"
}

export interface PayoutAccountPickerProps {
  accounts: PayoutAccount[]
  selected?: string
  onSelect: (id: string) => void
  onAdd: () => void
}

export function PayoutAccountPicker({ accounts, selected, onSelect, onAdd }: PayoutAccountPickerProps) {
  return (
    <div className="flex flex-col gap-2">
      {accounts.map(acc => (
        <button
          key={acc.id}
          type="button"
          onClick={() => onSelect(acc.id)}
          className={[
            'flex items-center gap-3 px-4 py-3.5 rounded-2xl bg-card border transition-all text-left',
            selected === acc.id ? 'border-brand ring-1 ring-brand/30' : 'border-border/50',
          ].join(' ')}
        >
          <CreditCard className="size-5 text-text-muted shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-text-primary truncate">{acc.summary}</p>
            <p className="text-xs text-text-muted">{acc.method}</p>
          </div>
          {selected === acc.id && (
            <span className="size-4 rounded-full bg-brand flex items-center justify-center shrink-0">
              <span className="size-2 rounded-full bg-white" />
            </span>
          )}
        </button>
      ))}

      <button
        type="button"
        onClick={onAdd}
        className="flex items-center gap-3 px-4 py-3.5 rounded-2xl border border-dashed border-border text-text-muted hover:border-brand/40 hover:text-brand-text transition-all"
      >
        <Plus className="size-5" />
        <span className="text-sm font-medium">Add payout account</span>
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

export function PayoutAccountForm({
  method, onMethod, holder, onHolder, fields, onField, busy, onSave, onCancel,
}: PayoutAccountFormProps) {
  return (
    <div className="flex flex-col gap-4">
      {/* Method tabs */}
      <div className="flex gap-1.5 bg-bg rounded-2xl p-1">
        {(['UPI', 'Bank transfer'] as PayoutMethod[]).map(m => (
          <button
            key={m}
            type="button"
            onClick={() => onMethod(m)}
            className={[
              'flex-1 h-9 rounded-xl text-sm font-medium transition-all',
              method === m ? 'bg-brand text-white' : 'text-text-secondary hover:text-text-primary',
            ].join(' ')}
          >
            {m}
          </button>
        ))}
      </div>

      {/* Account holder */}
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-text-muted font-medium uppercase tracking-wide">
          Account holder name
        </span>
        <input
          type="text"
          value={holder}
          onChange={e => onHolder(e.target.value)}
          placeholder="Full name as in bank"
          className="h-12 px-4 rounded-2xl bg-card border border-border text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
        />
      </label>

      {/* Dynamic fields */}
      {fields.map(f => (
        <label key={f.key} className="flex flex-col gap-1.5">
          <span className="text-xs text-text-muted font-medium uppercase tracking-wide">{f.label}</span>
          <input
            type="text"
            value={f.value}
            onChange={e => onField(f.key, e.target.value)}
            placeholder={f.placeholder}
            className="h-12 px-4 rounded-2xl bg-card border border-border text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
          />
        </label>
      ))}

      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 h-12 rounded-2xl border border-border text-text-secondary text-sm font-medium hover:bg-border/20 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={busy}
          className="flex-1 h-12 rounded-2xl bg-brand text-white font-semibold text-sm disabled:opacity-60 flex items-center justify-center gap-2"
        >
          {busy && <Loader2 className="size-4 animate-spin" />}
          Save account
        </button>
      </div>
    </div>
  )
}

// ─── CashOutTradeView ─────────────────────────────────────────────────────────

export type TradeStage =
  | 'escrow'
  | 'waiting_payment'
  | 'payment_sent'
  | 'released'
  | 'cancelled'
  | 'disputed'

export interface TradeMessage {
  id: string
  mine: boolean
  system?: boolean
  text: string
  time: string
}

export interface CashOutTradeViewProps {
  amountUsdc: string
  amountFiat: string
  buyer: string
  stage: TradeStage
  deadline?: string       // "Buyer pays within 28:40"
  account: string         // "UPI · sunil@okaxis"
  messages: TradeMessage[]
  draft: string
  onDraft: (v: string) => void
  onSend: () => void
  onRelease: () => void
  onCancel: () => void
  onDispute: () => void
  busy?: string
}

const STAGE_STEPS: { id: TradeStage; label: string }[] = [
  { id: 'escrow',          label: 'USDC locked' },
  { id: 'waiting_payment', label: 'Buyer pays ₹' },
  { id: 'payment_sent',    label: 'Confirm payment' },
  { id: 'released',        label: 'Done' },
]

const STAGE_INDEX: Record<TradeStage, number> = {
  escrow: 0, waiting_payment: 1, payment_sent: 2, released: 3,
  cancelled: -1, disputed: -1,
}

export function CashOutTradeView({
  amountUsdc, amountFiat, buyer, stage, deadline, account,
  messages, draft, onDraft, onSend, onRelease, onCancel, onDispute, busy,
}: CashOutTradeViewProps) {
  const activeIdx = STAGE_INDEX[stage]

  return (
    <div className="flex flex-col gap-5">
      {/* Amounts */}
      <div className="bg-card border border-border/50 rounded-3xl px-5 py-5 flex flex-col gap-1 items-center text-center">
        <p className="text-3xl font-bold tabular-nums text-text-primary">{amountUsdc}</p>
        <p className="text-lg tabular-nums text-text-secondary">{amountFiat}</p>
        <p className="text-xs text-text-muted mt-1">Buyer: {buyer}</p>
        {deadline && (
          <p className="text-xs font-semibold text-warning mt-2">{deadline}</p>
        )}
      </div>

      {/* Stepper */}
      {activeIdx >= 0 && (
        <div className="px-5">
          <div className="flex items-start gap-0">
            {STAGE_STEPS.map((step, i) => {
              const done    = i < activeIdx
              const current = i === activeIdx
              return (
                <React.Fragment key={step.id}>
                  <div className="flex flex-col items-center gap-1 flex-1">
                    <div className={[
                      'size-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors',
                      done    ? 'bg-success text-white' :
                      current ? 'bg-brand text-white ring-4 ring-brand/20' :
                                'bg-card border-2 border-border text-text-muted',
                    ].join(' ')}>
                      {done ? '✓' : i + 1}
                    </div>
                    <p className={`text-[10px] text-center leading-tight ${current ? 'text-brand-text font-semibold' : done ? 'text-success' : 'text-text-muted'}`}>
                      {step.label}
                    </p>
                  </div>
                  {i < STAGE_STEPS.length - 1 && (
                    <div className={`flex-1 h-0.5 mt-3.5 transition-colors ${done ? 'bg-success' : 'bg-border'}`} />
                  )}
                </React.Fragment>
              )
            })}
          </div>
        </div>
      )}

      {/* Payout account */}
      <div className="px-5 flex items-center gap-2 text-sm text-text-secondary">
        <CreditCard className="size-4 text-text-muted shrink-0" />
        <span>You receive at <span className="font-medium text-text-primary">{account}</span></span>
      </div>

      {/* Release warning */}
      {stage === 'payment_sent' && (
        <div className="mx-5 bg-warning/10 border border-warning/30 rounded-2xl px-4 py-3 flex gap-2">
          <AlertTriangle className="size-4 text-warning shrink-0 mt-0.5" />
          <p className="text-xs text-warning leading-relaxed">
            Release only after the ₹ is in your account. Never release for a screenshot.
          </p>
        </div>
      )}

      <Divider />

      {/* Chat */}
      <div className="px-5">
        <p className="text-xs text-text-muted font-medium uppercase tracking-wide mb-3">Chat with buyer</p>
        <div className="flex flex-col gap-2 mb-3 max-h-48 overflow-y-auto">
          <AnimatePresence>
            {messages.map(msg => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className={[
                  'flex',
                  msg.system ? 'justify-center' :
                  msg.mine   ? 'justify-end' : 'justify-start',
                ].join(' ')}
              >
                {msg.system ? (
                  <span className="text-[11px] text-text-muted px-3 py-1 rounded-full bg-card border border-border">
                    {msg.text}
                  </span>
                ) : (
                  <div className={[
                    'max-w-[75%] px-3.5 py-2 rounded-2xl',
                    msg.mine
                      ? 'bg-brand text-white rounded-br-sm'
                      : 'bg-card border border-border text-text-primary rounded-bl-sm',
                  ].join(' ')}>
                    <p className="text-sm">{msg.text}</p>
                    <p className={`text-[10px] mt-0.5 ${msg.mine ? 'text-white/60' : 'text-text-muted'}`}>
                      {new Date(msg.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={draft}
            onChange={e => onDraft(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && onSend()}
            placeholder="Message buyer…"
            className="flex-1 h-10 px-4 rounded-2xl bg-card border border-border text-text-primary text-sm placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand/40"
          />
          <button
            type="button"
            aria-label="Send message"
            onClick={onSend}
            disabled={!draft.trim()}
            className="size-10 rounded-2xl bg-brand text-white flex items-center justify-center disabled:opacity-40 transition-opacity"
          >
            <Send className="size-4" />
          </button>
        </div>
      </div>

      {/* Primary action */}
      <div className="px-5 flex flex-col gap-2">
        {stage === 'payment_sent' && (
          <button
            type="button"
            onClick={onRelease}
            disabled={!!busy}
            className="w-full h-13 rounded-2xl bg-brand text-white font-semibold text-base flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {busy === 'release' && <Loader2 className="size-4.5 animate-spin" />}
            I received {amountFiat} — release USDC
          </button>
        )}

        {(stage === 'escrow' || stage === 'waiting_payment' || stage === 'payment_sent') && (
          <div className="flex gap-2">
            {stage !== 'payment_sent' && (
              <button
                type="button"
                onClick={onCancel}
                disabled={!!busy}
                className="flex-1 h-11 rounded-2xl border border-border text-text-secondary text-sm font-medium hover:bg-border/20 transition-colors"
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              onClick={onDispute}
              disabled={!!busy}
              className="flex-1 h-11 rounded-2xl border border-danger/40 text-danger text-sm font-medium hover:bg-danger/5 transition-colors"
            >
              Dispute
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── CashOutHistory ───────────────────────────────────────────────────────────

export type CashOutHistoryStatus = 'active' | 'completed' | 'cancelled' | 'disputed'

export interface CashOutHistoryItem {
  id: string
  amountUsdc: string
  amountFiat: string
  buyer: string
  when: string
  status: CashOutHistoryStatus
}

export interface CashOutHistoryProps {
  items: CashOutHistoryItem[]
  onOpen: (id: string) => void
}

const STATUS_STYLE: Record<CashOutHistoryStatus, string> = {
  active:    'bg-brand/10 text-brand-text',
  completed: 'bg-success/10 text-success',
  cancelled: 'bg-border/50 text-text-muted',
  disputed:  'bg-danger/10 text-danger',
}
const STATUS_LABEL: Record<CashOutHistoryStatus, string> = {
  active: 'Active', completed: 'Completed', cancelled: 'Cancelled', disputed: 'Disputed',
}

export function CashOutHistory({ items, onOpen }: CashOutHistoryProps) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <p className="text-text-secondary font-medium">No cash-out history yet</p>
        <p className="text-sm text-text-muted">Completed trades will appear here.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          onClick={() => onOpen(item.id)}
          className="flex items-center gap-3 px-5 py-4 bg-card rounded-2xl border border-border/50 text-left hover:border-border transition-colors"
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-text-primary tabular-nums">
              {item.amountUsdc}
              <span className="text-text-muted font-normal"> · {item.amountFiat}</span>
            </p>
            <p className="text-xs text-text-muted mt-0.5">{item.buyer}</p>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${STATUS_STYLE[item.status]}`}>
              {STATUS_LABEL[item.status]}
            </span>
            <p className="text-[11px] text-text-muted">
              {new Date(item.when).toLocaleDateString([], { month: 'short', day: 'numeric' })}
            </p>
          </div>
        </button>
      ))}
    </div>
  )
}
