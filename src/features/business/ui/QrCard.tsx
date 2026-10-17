/**
 * QrCard — white card housing a 232 × 232 QR image.
 * Shows a skeleton while dataUrl is missing; animates to green "paid" state.
 */
import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle2 } from 'lucide-react'
import { Skeleton } from './primitives'
import { springs } from './types'

export interface QrCardProps {
  dataUrl?: string   // PNG data URL; skeleton shown when absent
  title?: string
  subtitle?: string
  paid?: boolean
}

export function QrCard({ dataUrl, title, subtitle, paid = false }: QrCardProps) {
  return (
    <div className="flex flex-col items-center">
      {/* Card */}
      <div className="relative bg-white rounded-3xl p-5 shadow-sm border border-border/40 flex flex-col items-center gap-3 w-[280px]">
        {/* QR area */}
        <div className="relative w-[232px] h-[232px] rounded-2xl overflow-hidden">
          <AnimatePresence mode="wait">
            {paid ? (
              /* Paid overlay */
              <motion.div
                key="paid"
                className="absolute inset-0 flex flex-col items-center justify-center bg-success/10 gap-2"
                initial={{ opacity: 0, scale: 0.88 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={springs.snappy}
              >
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ ...springs.snappy, delay: 0.05 }}
                >
                  <CheckCircle2 className="size-14 text-success" strokeWidth={1.5} />
                </motion.div>
                <p className="text-sm font-semibold text-success">Payment received</p>
              </motion.div>
            ) : dataUrl ? (
              <motion.img
                key="qr"
                src={dataUrl}
                alt="Payment QR code"
                className="w-full h-full object-contain"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.2 }}
              />
            ) : (
              /* Skeleton while loading */
              <motion.div
                key="skel"
                className="absolute inset-0 p-3 flex flex-col gap-2"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
              >
                {/* Coarse grid to mimic QR shape */}
                <div className="grid grid-cols-7 gap-1.5 flex-1">
                  {Array.from({ length: 49 }).map((_, i) => (
                    <Skeleton key={i} className="aspect-square rounded-[3px] bg-border/50" />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Optional text under QR */}
        {(title || subtitle) && (
          <div className="text-center">
            {title   && <p className="text-sm font-semibold text-[#1A1A1A] leading-snug">{title}</p>}
            {subtitle && <p className="text-xs text-[#666B73] mt-0.5">{subtitle}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
