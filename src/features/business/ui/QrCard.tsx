/**
 * QrCard — the app's one QR card, like payment apps' (PhonePe, Cash App): a
 * teal MeshPort header, who's paid, the QR on a white tile, what to do, and
 * the wallets that can scan it. The card follows the theme (dark in dark
 * mode); the QR always sits black on white so every scanner reads it. Home,
 * Receive, requests, bills, Shop QR and the order list all use it.
 * The QR is `dataUrl` (an image; skeleton until it's there) or `children`
 * (a screen's own canvas, e.g. one it downloads / shares from).
 */
import React, { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle2 } from 'lucide-react'
import { drawMeshportBadge } from '@/lib/qrLogo'
import { Skeleton } from './primitives'
import { springs } from './types'

export interface QrCardProps {
  dataUrl?: string   // PNG data URL; skeleton shown when absent
  /** Who's paid ("Royal Salons"). */
  title?: string
  /** Under the name ("Cutting Edge · rajesh.arc", "Request #42 · valid 1 hour"). */
  subtitle?: string
  /** Under the QR: what to do ("Scan to pay with MeshPort or any wallet"). */
  caption?: string
  /** The header's right side. */
  tag?: string
  paid?: boolean
  /** The QR itself (a canvas) instead of `dataUrl`. */
  children?: React.ReactNode
}

const TEAL = '#0F5C57'
export const QR_WALLETS = 'MeshPort · MetaMask · OKX · Trust · Coinbase'

function Badge() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => { if (ref.current) drawMeshportBadge(ref.current, 22) }, [])
  return <canvas ref={ref} width={22} height={22} aria-hidden style={{ width: 22, height: 22, flexShrink: 0 }} />
}

export function QrCard({ dataUrl, title, subtitle, caption = 'Scan to pay with MeshPort or any wallet', tag = 'USDC · any network', paid = false, children }: QrCardProps) {
  return (
    <div className="w-full max-w-[340px] mx-auto rounded-3xl overflow-hidden bg-surface border border-border" style={{ boxShadow: 'var(--shadow-1)' }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 text-white" style={{ background: TEAL }}>
        <Badge />
        <span className="text-[15px] font-extrabold">MeshPort</span>
        <span className="ml-auto text-[11.5px] font-semibold opacity-85">{tag}</span>
      </div>

      <div className="flex flex-col items-center gap-2.5 px-4 pt-3.5 pb-4">
        {(title || subtitle) && (
          <div className="text-center min-w-0 max-w-full">
            {title && <p className="text-[17px] font-extrabold text-text-primary leading-snug truncate">{title}</p>}
            {subtitle && <p className="text-[12.5px] text-text-secondary mt-0.5 truncate">{subtitle}</p>}
          </div>
        )}

        {/* The QR: black on a white tile in either theme */}
        <div className="bg-white rounded-[18px] p-2.5 flex">
          <div className="relative w-[232px] h-[232px] rounded-xl overflow-hidden flex items-center justify-center">
            <AnimatePresence mode="wait">
              {paid ? (
                <motion.div
                  key="paid"
                  className="absolute inset-0 flex flex-col items-center justify-center bg-success/10 gap-2"
                  initial={{ opacity: 0, scale: 0.88 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={springs.snappy}
                >
                  <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ ...springs.snappy, delay: 0.05 }}>
                    <CheckCircle2 className="size-14 text-success" strokeWidth={1.5} />
                  </motion.div>
                  <p className="text-sm font-semibold text-success">Payment received</p>
                </motion.div>
              ) : children ? (
                <motion.div key="own" className="absolute inset-0 flex items-center justify-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
                  {children}
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
                <motion.div key="skel" className="absolute inset-0 p-3 flex flex-col gap-2" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  <div className="grid grid-cols-7 gap-1.5 flex-1">
                    {Array.from({ length: 49 }).map((_, i) => (
                      <Skeleton key={i} className="aspect-square rounded-[3px] bg-black/10" />
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {!paid && caption && <p className="text-[12.5px] font-semibold text-text-primary text-center">{caption}</p>}
        {!paid && <p className="text-[11px] text-text-muted text-center">{QR_WALLETS}</p>}
      </div>
    </div>
  )
}
