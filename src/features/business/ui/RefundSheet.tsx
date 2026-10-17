/**
 * RefundSheet — confirm a refund.
 * Reason chips, optional note, non-reversible warning, danger confirm button.
 */
import React from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Sheet } from './primitives'

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
}: RefundSheetProps) {
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
          <p className="display text-4xl font-bold tabular-nums text-danger">{amount}</p>
          <p className="text-sm text-text-muted">
            Refund to <span className="font-medium text-text-secondary">{customer}</span>
          </p>
        </div>

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
            The USDC goes back to the customer from your Arc balance.
            This can&apos;t be undone.
          </p>
        </div>

        {/* Error */}
        {error && (
          <p className="text-xs text-danger text-center">{error}</p>
        )}

        {/* Confirm */}
        <button
          type="button"
          disabled={!reason || busy}
          onClick={onConfirm}
          className="w-full flex items-center justify-center gap-2 rounded-2xl py-4 text-sm font-semibold border-2 border-danger text-danger hover:bg-danger/10 active:scale-[0.98] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy && <Loader2 className="size-4 animate-spin" />}
          {busy ? 'Refunding…' : 'Confirm refund'}
        </button>
      </div>
    </Sheet>
  )
}
