/**
 * PaymentReceivedOverlay — the success popup shown on payment receipt.
 * Auto-dismiss is the parent's responsibility.
 */
import React from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2 } from 'lucide-react'
import { EASE_OUT } from '@/lib/motion'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'

export interface PaymentReceivedOverlayProps {
  open: boolean
  amount: string        // e.g. "$18.00"
  from: string          // e.g. "rahul.arc"
  chainLabel: string    // e.g. "Arc"
  order?: string
  onDone: () => void
}

export function PaymentReceivedOverlay({
  open,
  amount,
  from,
  chainLabel,
  order,
  onDone,
}: PaymentReceivedOverlayProps) {
  return (
    <AnimatePresence>
      {open && (
        // The app's centred popup (dim, pop-in, Esc, tap-outside, Back); the
        // card below draws its own look (green band), so the frame is bare.
        <DesktopDialogFrame onClose={onDone} bare maxWidth={384} zIndex={60}>
          <div className="relative w-full rounded-3xl bg-surface shadow-2xl overflow-hidden">
            {/* Green header band */}
            <div className="h-1.5 w-full bg-success" />

            <div className="flex flex-col items-center px-6 pb-8 pt-8 gap-4">
              {/* Animated tick */}
              <motion.div
                className="flex items-center justify-center size-20 rounded-full bg-success/15"
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ duration: 0.3, ease: EASE_OUT, delay: 0.1 }}
              >
                <CheckCircle2 className="size-10 text-success" strokeWidth={1.8} />
              </motion.div>

              {/* Label */}
              <p className="text-[11px] font-bold tracking-[0.12em] uppercase text-success">
                Payment received
              </p>

              {/* Amount */}
              <motion.p
                className="display text-5xl font-bold tabular-nums text-text-primary leading-none"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.18, duration: 0.22 }}
              >
                {amount}
              </motion.p>

              {/* From / chain */}
              <p className="text-sm text-text-muted text-center">
                from <span className="font-medium text-text-secondary">{from}</span>
                {' '}· on <span className="font-medium text-text-secondary">{chainLabel}</span>
              </p>

              {/* Order */}
              {order && (
                <span className="rounded-xl bg-border/40 px-3 py-1 text-xs font-medium text-text-muted">
                  {order}
                </span>
              )}

              {/* Done */}
              <button
                type="button"
                onClick={onDone}
                className="mt-2 w-full rounded-2xl py-4 bg-brand text-white text-sm font-semibold hover:bg-brand/90 active:scale-[0.98] transition-all"
              >
                Done
              </button>
            </div>
          </div>
        </DesktopDialogFrame>
      )}
    </AnimatePresence>
  )
}
