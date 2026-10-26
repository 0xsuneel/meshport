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
import { CheckCircle2, ChevronDown, Copy } from 'lucide-react'
import { drawMeshportBadge } from '@/lib/qrLogo'
import { Skeleton } from './primitives'
import { springs } from './types'

export interface QrCardProps {
  dataUrl?: string   // PNG data URL; skeleton shown when absent
  /** Who's paid ("Royal Salons"). */
  title?: string
  /** Under the name ("Cutting Edge · rajesh.arc", "Request #42 · valid 1 hour"). */
  subtitle?: string
  /** Under the QR: what to do ("Scan to pay with MeshPort or any wallet"),
   *  or a request's live status. */
  caption?: React.ReactNode
  /** The header's right side. */
  tag?: string
  paid?: boolean
  /** The QR itself (a canvas) instead of `dataUrl`. */
  children?: React.ReactNode
  /** Over the QR in place of the name (Receive: username and address to copy). */
  top?: React.ReactNode
}

const TEAL = '#0F5C57'
export const QR_WALLETS = 'MeshPort · MetaMask · OKX · Trust · Coinbase'

/** A small box on the card over the QR ("Username · rajesh.arc"), side by
 *  side with another (QrCard's `top`). With `onCopy` it copies on tap. Tinted
 *  with the brand colour - the page colour looked like an empty hole on the
 *  card in dark mode. */
export function QrInfoBox({ label, value, onCopy, copied = false, mono = true, onOpen }: {
  label: string; value: string; onCopy?: () => void; copied?: boolean; mono?: boolean
  /** Tap opens more (a bill's items): a ▾ in place of the copy icon. */
  onOpen?: () => void
}) {
  const body = (
    <>
      <span className="flex-1 min-w-0">
        <span className="block text-[11px] font-semibold text-brand-text">{label}</span>
        <span className="block font-semibold text-text-primary truncate" style={{ fontSize: 'clamp(11px, 3.4vw, 13px)', ...(mono ? { fontFamily: 'ui-monospace, monospace' } : null) }}>{value}</span>
      </span>
      {onCopy && (copied ? <CheckCircle2 data-tick className="w-4 h-4 text-success flex-shrink-0" /> : <Copy className="w-4 h-4 text-brand-text flex-shrink-0" />)}
      {!onCopy && onOpen && <ChevronDown className="w-4 h-4 text-brand-text flex-shrink-0" />}
    </>
  )
  // Sized to their text (flex-auto): a long username gets the room a short
  // address doesn't need, instead of both being cut at half width.
  const cls = 'flex-auto min-w-0 flex items-center gap-2 rounded-xl px-3 py-2 text-left'
  const style = { background: 'color-mix(in srgb, var(--brand) 12%, var(--surface))', border: '1px solid color-mix(in srgb, var(--brand) 28%, transparent)' }
  const tap = onCopy ?? onOpen
  return tap
    ? <button type="button" onClick={tap} aria-label={onCopy ? `Copy ${label.toLowerCase()}` : `${label}: ${value}`} className={`${cls} active:scale-[0.98] transition-transform`} style={style}>{body}</button>
    : <div className={cls} style={style}>{body}</div>
}

function Badge() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => { if (ref.current) drawMeshportBadge(ref.current, 22) }, [])
  return <canvas ref={ref} width={22} height={22} aria-hidden style={{ width: 22, height: 22, flexShrink: 0 }} />
}

export function QrCard({ dataUrl, title, subtitle, caption = 'Scan to pay with MeshPort or any wallet', tag = 'USDC · any network', paid = false, children, top }: QrCardProps) {
  return (
    <div className="w-full max-w-[340px] mx-auto rounded-3xl overflow-hidden bg-surface border border-border" style={{ boxShadow: 'var(--shadow-1)' }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 text-white" style={{ background: TEAL }}>
        <Badge />
        <span className="text-[15px] font-extrabold">MeshPort</span>
        <span className="ml-auto text-[12px] font-semibold opacity-85">{tag}</span>
      </div>

      <div className="flex flex-col items-center gap-2.5 px-4 pt-3.5 pb-4">
        {top ?? ((title || subtitle) && (
          <div className="text-center min-w-0 max-w-full">
            {title && <p className="text-[17px] font-extrabold text-text-primary leading-snug truncate">{title}</p>}
            {subtitle && <p className="text-[13px] text-text-secondary mt-0.5 truncate">{subtitle}</p>}
          </div>
        ))}

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
                  <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ ...springs.snappy, delay: 0.05 }}>
                    <CheckCircle2 className="size-14 text-success" strokeWidth={1.5} />
                  </motion.div>
                  <p className="text-sm font-semibold text-success">Payment received</p>
                </motion.div>
              ) : children ? (
                // Plain elements, no framer fade: a re-render mid-fade (the
                // app's polling) made framer drop the QR to opacity 0 for a
                // frame as the fade finished - a blink. The screen's canvas
                // fades itself in (CSS), the image with qr-fade-in.
                <div key="own" className="absolute inset-0 flex items-center justify-center">
                  {children}
                </div>
              ) : dataUrl ? (
                <img decoding="async" key="qr" src={dataUrl} alt="Payment QR code" className="w-full h-full object-contain qr-fade-in" />
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

        {!paid && caption && <p className="text-[13px] font-semibold text-text-primary text-center">{caption}</p>}
        {!paid && <p className="text-[11px] text-text-muted text-center">{QR_WALLETS}</p>}
      </div>
    </div>
  )
}
