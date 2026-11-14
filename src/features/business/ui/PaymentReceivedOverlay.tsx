/**
 * PaymentReceivedOverlay — the "Payment received" card shown over the app
 * when a business payment lands: the amount large, who paid, the order and
 * store, the words the voice says (tap them to hear it again), and Mute
 * alerts / View payment. Several payments queue: "+N more waiting".
 * Auto-dismiss and the queue are the parent's (PaymentReceivedWatcher).
 */
import React from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check } from 'lucide-react'
import { EASE_OUT } from '@/lib/motion'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'

export interface PaymentReceivedOverlayProps {
  open: boolean
  amount: string        // e.g. "$18.00"
  from: string          // e.g. "rahul.arc"
  chainLabel: string    // e.g. "Arc"
  /** e.g. "Bill #170" */
  order?: string
  /** The store it was paid at, when the business has more than one */
  store?: string
  /** The words the voice says, when voice alerts are on */
  spoken?: string
  /** Payments waiting behind this one */
  more?: number
  /** Say this payment again (tapping the spoken words) */
  onRepeat?: () => void
  /** Turn voice alerts off (shown while they're on) */
  onMute?: () => void
  /** Open this payment */
  onView?: () => void
  /** Changes per payment, so the next queued one animates in */
  itemKey?: string
  onDone: () => void
}

export function PaymentReceivedOverlay({
  open, amount, from, chainLabel, order, store, spoken, more = 0, onRepeat, onMute, onView, itemKey, onDone,
}: PaymentReceivedOverlayProps) {
  const [whole, cents] = amount.split('.')
  const band = [order, store].filter(Boolean).join(' · ')
  return (
    <AnimatePresence>
      {open && (
        // The app's centred popup (dim, pop-in, Esc, tap-outside, Back); the
        // card below draws its own look, so the frame is bare.
        <DesktopDialogFrame onClose={onDone} bare maxWidth={384} zIndex={60}>
          <div className="relative w-full">
            {more > 0 && (
              <div className="flex justify-center mb-3">
                <span className="rounded-full bg-surface px-3.5 py-1.5 text-[12.5px] font-bold text-brand-text shadow-lg">
                  +{more} more payment{more === 1 ? '' : 's'} waiting
                </span>
              </div>
            )}
            <div key={itemKey} className="w-full rounded-3xl bg-surface shadow-2xl overflow-hidden">
              {/* Brand band: what this is and where */}
              <div className="bg-brand text-white text-center px-5 pt-5 pb-11">
                <p className="text-[14px] font-bold tracking-[0.04em] uppercase">Payment received</p>
                <p className="text-[12.5px] opacity-85 mt-0.5 min-h-[1.2em]">{band || `on ${chainLabel}`}</p>
              </div>

              <div className="flex flex-col items-center px-5 pb-5">
                {/* Tick, sitting on the band's edge */}
                <motion.div
                  className="-mt-9 flex items-center justify-center size-[72px] rounded-full bg-surface shadow-md"
                  initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                  transition={{ duration: 0.3, ease: EASE_OUT, delay: 0.05 }}>
                  <span className="flex items-center justify-center size-14 rounded-full bg-success text-white">
                    <Check className="size-7" strokeWidth={3} />
                  </span>
                </motion.div>

                <motion.p className="display mt-3 font-bold tabular-nums text-text-primary leading-none"
                  initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12, duration: 0.22 }}>
                  <span className="text-[44px] tracking-tight">{whole}{cents != null ? `.${cents}` : ''}</span>
                  <span className="ml-1.5 text-[15px] font-semibold text-text-muted">USDC</span>
                </motion.p>
                <p className="mt-2 text-[15px] text-text-secondary text-center">
                  from <span className="font-semibold text-text-primary">{from}</span>
                </p>
                <p className="mt-0.5 text-[12.5px] text-text-muted">Just now · on {chainLabel}</p>

                {/* What the voice says - tap to hear it again */}
                {spoken && (
                  <button type="button" onClick={onRepeat} disabled={!onRepeat} aria-label="Say it again"
                    className="mt-4 w-full flex items-center gap-3 rounded-2xl bg-brand/10 px-3.5 py-3 text-left active:scale-[0.99] transition">
                    <span aria-hidden className="flex items-center gap-[3px] h-6 shrink-0">
                      {[8, 18, 12, 22, 10, 16, 7].map((h, i) => (
                        <span key={i} className="w-[3px] rounded-full bg-brand" style={{ height: h }} />
                      ))}
                    </span>
                    <span className="text-[13px] font-semibold text-brand-text leading-snug text-pretty">&ldquo;{spoken}&rdquo;</span>
                  </button>
                )}

                <div className="mt-4 w-full flex gap-2.5">
                  {onMute ? (
                    <button type="button" onClick={onMute}
                      className="flex-1 h-12 rounded-2xl border border-border bg-bg text-[14px] font-semibold text-text-primary active:scale-[0.98] transition">
                      Mute alerts
                    </button>
                  ) : (
                    <button type="button" onClick={onDone}
                      className="flex-1 h-12 rounded-2xl border border-border bg-bg text-[14px] font-semibold text-text-primary active:scale-[0.98] transition">
                      {more > 0 ? 'Next' : 'Close'}
                    </button>
                  )}
                  <button type="button" onClick={onView ?? onDone}
                    className="flex-1 h-12 rounded-2xl bg-brand text-white text-[14px] font-semibold active:scale-[0.98] transition">
                    {onView ? 'View payment' : 'Done'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </DesktopDialogFrame>
      )}
    </AnimatePresence>
  )
}
