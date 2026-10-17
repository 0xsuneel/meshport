/**
 * PaymentReceivedOverlay — full-screen success overlay shown on payment receipt.
 * Auto-dismiss is the parent's responsibility.
 */
import React from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2 } from 'lucide-react'

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
        <motion.div
          className="fixed inset-0 z-[60] flex items-center justify-center px-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {/* Dim */}
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

          {/* Card */}
          <motion.div
            className="relative w-full max-w-sm rounded-3xl bg-surface shadow-2xl overflow-hidden"
            initial={{ scale: 0.88, y: 20, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.92, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 32 }}
          >
            {/* Green header band */}
            <div className="h-1.5 w-full bg-success" />

            <div className="flex flex-col items-center px-6 pb-8 pt-8 gap-4">
              {/* Animated tick */}
              <motion.div
                className="flex items-center justify-center size-20 rounded-full bg-success/15"
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 500, damping: 28, delay: 0.1 }}
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
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
