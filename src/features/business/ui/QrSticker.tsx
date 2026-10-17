/**
 * QrSticker — A6-sized printable counter sticker.
 * Root carries `print-only-area` class; @media print in index.css hides everything else.
 */
import React from 'react'
import { Skeleton } from './primitives'

export interface QrStickerProps {
  dataUrl?: string   // PNG data URL; skeleton while absent
  storeName: string
  handle: string     // e.g. "sharma.arc"
}

export function QrSticker({ dataUrl, storeName, handle }: QrStickerProps) {
  return (
    /* A6 = 105 × 148 mm; at 96 dpi → ~397 × 559 px */
    <div
      className="print-only-area flex flex-col items-stretch overflow-hidden rounded-3xl border border-border bg-white shadow-md"
      style={{ width: 320, fontFamily: '"DM Sans", sans-serif' }}
      role="img"
      aria-label={`Payment QR sticker for ${storeName}`}
    >
      {/* Brand header band */}
      <div className="flex flex-col items-center gap-1 bg-brand px-6 py-5">
        <p
          className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/70"
          style={{ letterSpacing: '0.12em' }}
        >
          Scan &amp; pay with USDC
        </p>
        <p className="text-lg font-bold text-white display tracking-tight">MeshPort</p>
      </div>

      {/* QR */}
      <div className="flex justify-center px-8 pt-7 pb-5">
        {dataUrl ? (
          <img
            src={dataUrl}
            alt="Payment QR code"
            width={200}
            height={200}
            className="rounded-2xl"
          />
        ) : (
          <div className="w-[200px] h-[200px] rounded-2xl overflow-hidden">
            <div className="grid grid-cols-7 gap-1 p-3 w-full h-full">
              {Array.from({ length: 49 }).map((_, i) => (
                <Skeleton key={i} className="aspect-square rounded-[3px] bg-border/40" />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Store info */}
      <div className="flex flex-col items-center px-6 pb-5 gap-1">
        <p className="text-base font-bold text-[#1A1A1A] text-center leading-snug">{storeName}</p>
        <p className="text-sm font-mono text-[#666B73]">{handle}</p>
      </div>

      {/* Footer */}
      <div className="border-t border-[#D8DBE0] px-6 py-4">
        <p className="text-[10px] text-center text-[#8A9099] leading-relaxed">
          Accepted from Arc, Base, Ethereum and more
        </p>
      </div>
    </div>
  )
}
