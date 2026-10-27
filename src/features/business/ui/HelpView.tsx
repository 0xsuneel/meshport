/**
 * HelpView — "Customer says they paid" lookup + FAQ accordion.
 * Pure presentational; all state lives in the parent.
 */
import React from 'react'
import { ChevronDown, ChevronUp, Search, Loader2, CheckCircle2, XCircle, AlertTriangle, UserPlus } from 'lucide-react'
import { ChainLogo, Divider } from './primitives'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HelpChain {
  id: string
  label: string
  logo: string
}

export interface UnmatchedPayment {
  id: string
  amount: string
  from: string
  chainLabel: string
  when: string     // ISO
}

export interface FaqItem {
  q: string
  a: string
}

export type HelpResultTone = 'success' | 'danger' | 'warning'

export interface HelpViewProps {
  chains: HelpChain[]
  chain: string
  onChain: (id: string) => void
  txHash: string
  onTxHash: (v: string) => void
  orders: { code: string; label: string }[]
  order: string
  onOrder: (code: string) => void
  busy: boolean
  result?: { tone: HelpResultTone; title: string; text: string }
  onCheck: () => void
  unmatched: UnmatchedPayment[]
  onAssign: (id: string) => void
  faq: FaqItem[]
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const RESULT_CONFIG: Record<HelpResultTone, { Icon: React.ElementType; bg: string; border: string; text: string }> = {
  success: { Icon: CheckCircle2, bg: 'bg-success/10', border: 'border-success/30', text: 'text-success' },
  danger:  { Icon: XCircle,      bg: 'bg-danger/10',  border: 'border-danger/30',  text: 'text-danger' },
  warning: { Icon: AlertTriangle,bg: 'bg-warning/10', border: 'border-warning/20', text: 'text-warning' },
}

function ResultBanner({ tone, title, text }: { tone: HelpResultTone; title: string; text: string }) {
  const { Icon, bg, border, text: textCls } = RESULT_CONFIG[tone]
  return (
    <div className={`flex items-start gap-3 rounded-2xl ${bg} border ${border} px-4 py-3.5`}>
      <Icon className={`size-4 shrink-0 mt-0.5 ${textCls}`} />
      <div>
        <p className={`text-sm font-semibold ${textCls}`}>{title}</p>
        <p className="text-xs text-text-secondary mt-0.5 leading-relaxed">{text}</p>
      </div>
    </div>
  )
}

function FaqRow({ q, a }: FaqItem) {
  const [open, setOpen] = React.useState(false)
  return (
    <div className="border-b border-border last:border-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between py-4 text-left gap-3 min-h-[52px]"
      >
        <span className="text-sm font-medium text-text-primary">{q}</span>
        {open
          ? <ChevronUp className="size-4 text-text-muted shrink-0" />
          : <ChevronDown className="size-4 text-text-muted shrink-0" />}
      </button>
      {open && (
        <p className="pb-4 text-sm text-text-muted leading-relaxed">{a}</p>
      )}
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function HelpView({
  chains,
  chain,
  onChain,
  txHash,
  onTxHash,
  orders,
  order,
  onOrder,
  busy,
  result,
  onCheck,
  unmatched,
  onAssign,
  faq,
}: HelpViewProps) {
  return (
    <div className="flex flex-col gap-6 pb-10 px-5 pt-6">

      {/* ── Customer says they paid ─────────────────────────────────────── */}
      <section>
        <p className="text-base font-semibold text-text-primary mb-1">Customer says they paid</p>
        <p className="text-xs text-text-muted mb-5">
          Enter the transaction details and we&apos;ll find the payment.
        </p>

        {/* Chain picker */}
        <div className="flex flex-col gap-2 mb-4">
          <p className="text-xs font-semibold text-text-muted">Chain</p>
          <div className="flex gap-2 flex-wrap">
            {chains.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onChain(c.id)}
                className={`inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-xs font-medium transition-colors min-h-[40px] ${
                  chain === c.id
                    ? 'bg-brand text-white'
                    : 'bg-surface border border-border text-text-secondary hover:border-text-muted'
                }`}
              >
                <ChainLogo src={c.logo} label={c.label} size={18} />
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tx hash input */}
        <div className="flex flex-col gap-2 mb-4">
          <label
            htmlFor="help-txhash"
            className="text-xs font-semibold text-text-muted"
          >
            Transaction hash
          </label>
          <div className="flex items-center gap-2 bg-surface border border-border rounded-2xl px-3.5 py-3">
            <Search className="size-4 text-text-muted shrink-0" />
            <input
              id="help-txhash"
              type="text"
              placeholder="0x…"
              value={txHash}
              onChange={(e) => onTxHash(e.target.value)}
              className="flex-1 bg-transparent text-sm ![font-size:max(var(--fs-field,0px),0.875rem)] font-mono text-text-primary placeholder:text-text-muted outline-none"
            />
          </div>
        </div>

        {/* Order picker */}
        {orders.length > 0 && (
          <div className="flex flex-col gap-2 mb-4">
            <p className="text-xs font-semibold text-text-muted">
              Attach to order <span className="normal-case font-normal">(optional)</span>
            </p>
            <div className="flex flex-col gap-1">
              {orders.map((o) => (
                <button
                  key={o.code}
                  type="button"
                  onClick={() => onOrder(o.code)}
                  className={`flex items-center justify-between px-4 py-3 rounded-2xl text-sm transition-colors min-h-[48px] ${
                    order === o.code
                      ? 'bg-brand/10 border border-brand/20 text-brand-text'
                      : 'bg-surface border border-border text-text-secondary hover:border-text-muted'
                  }`}
                >
                  <span>{o.label}</span>
                  {order === o.code && <CheckCircle2 className="size-4 text-brand-text" />}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Result banner */}
        {result && <div className="mb-4"><ResultBanner {...result} /></div>}

        {/* Check button */}
        <button
          type="button"
          disabled={!txHash.trim() || busy}
          onClick={onCheck}
          className="w-full flex items-center justify-center gap-2 rounded-2xl py-4 bg-brand text-white text-sm font-semibold hover:bg-brand/90 active:scale-[0.98] transition disabled:opacity-40 disabled:cursor-not-allowed min-h-[52px]"
        >
          {busy && <Loader2 className="size-4 animate-spin" />}
          {busy ? 'Checking…' : 'Check & attach'}
        </button>
      </section>

      <Divider />

      {/* ── Unmatched payments ──────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <p className="text-base font-semibold text-text-primary">Payments without an order</p>
          {unmatched.length > 0 && (
            <span className="text-xs text-text-muted tabular-nums">{unmatched.length}</span>
          )}
        </div>

        {unmatched.length === 0 ? (
          <div className="flex flex-col items-center py-10 text-center">
            <CheckCircle2 className="size-8 text-success mb-3" />
            <p className="text-sm font-medium text-text-secondary">All payments are matched</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {unmatched.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-3 rounded-2xl bg-surface soft-card px-4 py-3.5"
              >
                <ChainLogo src="" label={p.chainLabel} size={36} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary truncate">{p.from}</p>
                  <p className="text-xs text-text-muted">
                    {p.chainLabel} · {new Date(p.when).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <span className="text-sm font-semibold tabular-nums text-text-primary">{p.amount}</span>
                  <button
                    type="button"
                    aria-label={`Assign payment from ${p.from}`}
                    onClick={() => onAssign(p.id)}
                    className="inline-flex items-center gap-1 rounded-xl bg-brand/10 px-2.5 py-1 text-[11px] font-semibold text-brand-text hover:bg-brand/20 transition-colors"
                  >
                    <UserPlus className="size-3" />
                    Assign
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <Divider />

      {/* ── FAQ ─────────────────────────────────────────────────────────── */}
      <section>
        <p className="text-base font-semibold text-text-primary mb-2">Help & FAQ</p>
        {faq.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-sm text-text-muted">No FAQ items</p>
          </div>
        ) : (
          <div className="rounded-2xl bg-surface soft-card px-4">
            {faq.map((item, i) => <FaqRow key={i} q={item.q} a={item.a} />)}
          </div>
        )}
      </section>
    </div>
  )
}
