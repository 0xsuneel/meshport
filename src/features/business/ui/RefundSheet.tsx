/**
 * RefundSheet — confirm a refund.
 * Reason chips, optional note, non-reversible warning, danger confirm button.
 */
import React from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Sheet } from './primitives'
import { AmountKeypad, sanitizeAmountInput } from '@/components/ui/AmountKeypad'
import { AmountField } from '@/components/ui/AmountField'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DESKTOP_QUERY } from '@/lib/motion'

export interface RefundSheetProps {
  open: boolean
  amount: string        // e.g. "$12.50"
  customer: string      // e.g. "rahul.arc"
  reasons: string[]
  reason: string
  onReason: (r: string) => void
  note: string
  onNote: (n: string) => void
  busy: boolean
  error?: string
  onConfirm: () => void
  onClose: () => void
  /** Where the money goes back (e.g. On Arc / On Base, where they paid). */
  destinations?: { id: string; label: string; hint: string }[]
  destination?: string
  onDestination?: (id: string) => void
  /** Line under the warning, e.g. the fee for a refund on another chain. */
  note2?: string
  /** Partial refunds: the amount typed (USDC) and the most that can go back. */
  value?: string
  onValue?: (v: string) => void
  max?: number
  /** Why this refund can't go now (e.g. not enough USDC on that chain). */
  blocked?: string
  /** Earlier refunds of this payment, e.g. "$5.00 of $20.00 already refunded". */
  already?: string
}

export function RefundSheet({
  open,
  amount,
  customer,
  reasons,
  reason,
  onReason,
  note,
  onNote,
  busy,
  error,
  onConfirm,
  onClose,
  destinations,
  destination,
  onDestination,
  note2,
  value,
  onValue,
  max,
  blocked,
  already,
}: RefundSheetProps) {
  const typed = Number(value)
  // Refunds are whole cents, at least $0.01; `max` is what's still left on the payment.
  const top = max != null ? Math.floor(max * 100 + 1e-6) / 100 : 0
  const badAmount = !!onValue && !(typed + 1e-9 >= 0.01 && max != null && typed <= max + 1e-9)
  const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  // Phone: the amount is entered on the app's keypad, right in this sheet
  // (the rest folds away until Done). Desktop types straight in.
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  const [editing, setEditing] = React.useState(false)
  React.useEffect(() => { if (!open) setEditing(false) }, [open])
  const keypadUp = editing && !isDesktop
  const over = max != null && typed > max + 1e-9
  return (
    <Sheet open={open} onClose={onClose}>
      <div className="flex flex-col px-5 pb-8 pt-2 overflow-y-auto max-h-[88dvh] gap-5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-text-secondary">Refund payment</p>
          <button
            type="button"
            aria-label="Close refund sheet"
            onClick={onClose}
            className="size-8 flex items-center justify-center rounded-xl text-text-muted hover:bg-border/40 transition-colors"
          >
            <span className="text-lg leading-none">&times;</span>
          </button>
        </div>

        {/* Amount hero */}
        <div className="flex flex-col items-center gap-1 py-2">
          {onValue && max != null ? (
            <>
              <div className="w-full">
                <AmountField value={value ?? ''} onChange={raw => onValue(sanitizeAmountInput(raw, 2))} ariaLabel="Refund amount" autoFocus={false}
                  token={{ label: 'USDC', logo: '/logos/tokens/usdc.png' }} invalid={over}
                  quick={[{ l: already ? 'All left' : 'Full', v: top }, { l: 'Half', v: Math.floor(max * 50) / 100 }].filter(o => o.v >= 0.01)
                    .map(o => ({ label: `${o.l} · ${fmt(o.v)}`, onClick: () => onValue(o.v.toFixed(2)) }))}
                  onTap={isDesktop ? undefined : () => { (document.activeElement as HTMLElement | null)?.blur?.(); setEditing(true) }} editing={keypadUp} />
              </div>
              {over && <p className="text-xs text-danger mt-1">At most {fmt(top)} - what's left on this payment</p>}
            </>
          ) : (
            <p className="display text-4xl font-bold tabular-nums text-danger">{amount}</p>
          )}
          <p className="text-sm text-text-muted">
            Refund to <span className="font-medium text-text-secondary">{customer}</span>
          </p>
          {already && <p className="text-xs text-text-muted">{already}</p>}
        </div>

        {keypadUp && onValue && max != null ? (
          <AmountKeypad variant="inline" open value={value ?? ''} onChange={v => onValue(sanitizeAmountInput(v, 2))} token="USDC"
            decimals={2} showMax={false} balance={max} onDone={() => setEditing(false)} doneLabel="Done" replaceOnFirstKey />
        ) : (<>
        {/* Where it goes back */}
          {destinations && destinations.length > 1 && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">Send back on</p>
              <div className="grid grid-cols-2 gap-2">
                {destinations.map(d => (
                  <button key={d.id} type="button" onClick={() => onDestination?.(d.id)} aria-pressed={destination === d.id}
                    className={`text-left rounded-2xl border px-3.5 py-3 min-h-[60px] transition-colors ${destination === d.id ? 'border-brand bg-brand/10' : 'border-border bg-surface'}`}>
                    <span className={`block text-sm font-semibold ${destination === d.id ? 'text-brand-text' : 'text-text-primary'}`}>{d.label}</span>
                    <span className="block text-[11px] text-text-muted mt-0.5 leading-snug">{d.hint}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
  
          {/* Reason chips */}
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">Reason</p>
            <div className="flex flex-wrap gap-2">
              {reasons.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => onReason(r)}
                  className={`rounded-full px-4 py-2 text-xs font-medium transition-colors min-h-[36px] ${
                    reason === r
                      ? 'bg-danger/10 text-danger border border-danger/30'
                      : 'bg-surface border border-border text-text-secondary hover:border-text-muted'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
  
          {/* Optional note */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-text-muted uppercase tracking-wider" htmlFor="refund-note">
              Note <span className="normal-case font-normal text-text-muted">(optional)</span>
            </label>
            <input
              id="refund-note"
              type="text"
              placeholder="Add a note for your records..."
              value={note}
              onChange={(e) => onNote(e.target.value)}
              className="w-full bg-transparent border-b border-border py-2 text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-text-secondary transition-colors"
            />
          </div>
  
          {/* Warning box */}
          <div className="flex items-start gap-3 rounded-2xl bg-warning/10 border border-warning/20 px-4 py-3.5">
            <AlertTriangle className="size-4 text-warning shrink-0 mt-0.5" />
            <p className="text-xs text-text-secondary leading-relaxed">
              The USDC goes back to the wallet that paid you.
              This can&apos;t be undone.
              {onValue && max != null && typed > 0 && typed < max - 1e-9 && max - typed >= 0.01 - 1e-9 && (
                <span className="block mt-1 font-medium">You can refund up to {fmt(Math.floor((max - typed) * 100 + 1e-6) / 100)} more later.</span>
              )}
              {note2 && <span className="block mt-1 text-text-muted">{note2}</span>}
            </p>
          </div>
  
          {/* Error */}
          {(error || blocked) && (
            <p className="text-xs text-danger text-center">{error || blocked}</p>
          )}
  
          {/* Confirm */}
          <button
            type="button"
            disabled={!reason || busy || badAmount || !!blocked}
            onClick={onConfirm}
            className="w-full flex items-center justify-center gap-2 rounded-2xl py-4 text-sm font-semibold border-2 border-danger text-danger hover:bg-danger/10 active:scale-[0.98] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy ? 'Refunding…' : 'Confirm refund'}
          </button>
        </>)}
      </div>
    </Sheet>
  )
}
