/**
 * ReceiptCard — a paper-style receipt for a business payment: the business
 * (photo, name, handle, store), Paid / Refunded, the amount, who paid, what
 * for, the network and transaction, and MeshPort's mark at the foot.
 * White on purpose in both themes - it's screenshotted, shared and printed.
 * When printable=true, adds class print-only-area so @media print shows it.
 */
import React from 'react'
import { Check, ExternalLink, Undo2 } from 'lucide-react'
import { MeshPortLogo } from '@/components/ui/MeshPortLogo'

export interface ReceiptCardProps {
  storeName: string
  handle: string
  /** The business's profile photo */
  avatar?: string | null
  /** The store (outlet) it was paid at, when there are several */
  outlet?: string | null
  amount: string
  from: string
  chainLabel: string
  /** What it paid: "Bill #170", "Shop QR payment"… */
  order?: string
  time: string      // ISO
  txHash?: string
  /** The transaction on its own chain's explorer */
  explorerUrl?: string
  refunded?: boolean
  printable?: boolean
}

const INK = '#0F5C57'

export function ReceiptCard({
  storeName, handle, avatar, outlet, amount, from, chainLabel, order, time, txHash, explorerUrl,
  refunded = false, printable = false,
}: ReceiptCardProps) {
  const when = new Date(time)
  const date = when.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
  const clock = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const [whole, cents] = amount.replace(/^\$/, '').split('.')
  const rows: { label: string; value: string; mono?: boolean }[] = [
    { label: 'Paid by', value: from },
    ...(order ? [{ label: 'For', value: order }] : []),
    ...(outlet ? [{ label: 'Store', value: outlet }] : []),
    { label: 'Network', value: chainLabel },
    ...(txHash ? [{ label: 'Transaction', value: `${txHash.slice(0, 10)}…${txHash.slice(-6)}`, mono: true }] : []),
  ]

  return (
    <div className={`w-full max-w-[340px] mx-auto ${printable ? 'print-only-area' : ''}`}
      style={{ filter: printable ? undefined : 'drop-shadow(0 14px 28px rgba(15, 40, 38, 0.16))' }}>
      <div className="bg-white text-[#1B1D1F] rounded-t-[26px] overflow-hidden"
        // A torn-paper bottom edge.
        style={{
          WebkitMask: 'radial-gradient(circle at 7px 100%, transparent 6px, #000 6.5px) -7px 100% / 14px 8px repeat-x, linear-gradient(#000 0 0) 0 0 / 100% calc(100% - 7px) no-repeat',
          mask: 'radial-gradient(circle at 7px 100%, transparent 6px, #000 6.5px) -7px 100% / 14px 8px repeat-x, linear-gradient(#000 0 0) 0 0 / 100% calc(100% - 7px) no-repeat',
        }}>
        {/* Business */}
        <div className="flex flex-col items-center px-6 pt-7 pb-5" style={{ background: 'linear-gradient(180deg, #EEF6F4 0%, #FFFFFF 100%)' }}>
          {avatar
            ? <img src={avatar.split('?')[0]} alt="" className="size-16 rounded-2xl object-cover ring-4 ring-white shadow-sm" />
            : (
              <span className="size-16 rounded-2xl ring-4 ring-white shadow-sm flex items-center justify-center text-[26px] font-bold text-white"
                style={{ background: INK }}>
                {storeName.trim()[0]?.toUpperCase() ?? 'S'}
              </span>
            )}
          <p className="mt-3 text-[18px] font-bold leading-tight text-center">{storeName}</p>
          <p className="text-[13px] text-[#62676C] mt-0.5">{handle}</p>
        </div>

        {/* Status + amount */}
        <div className="flex flex-col items-center px-6 pb-6">
          {refunded ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#FDECEC] px-3 py-1 text-[12px] font-bold text-[#B42318]">
              <Undo2 className="size-3.5" strokeWidth={2.6} /> Refunded
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#E7F4EC] px-3 py-1 text-[12px] font-bold text-[#1F7A45]">
              <Check className="size-3.5" strokeWidth={3} /> Paid
            </span>
          )}
          <p className={`mt-3 leading-none tabular-nums ${refunded ? 'line-through opacity-50' : ''}`} style={{ fontFamily: 'Space Grotesk, DM Sans, sans-serif' }}>
            <span className="text-[26px] font-bold align-top relative top-1.5 mr-0.5">$</span>
            <span className="text-[48px] font-bold tracking-tight">{whole}</span>
            {cents != null && <span className="text-[26px] font-bold">.{cents}</span>}
            <span className="ml-1.5 text-[14px] font-semibold text-[#62676C]">USDC</span>
          </p>
          <p className="mt-2 text-[13px] text-[#62676C]">{date} · {clock}</p>
        </div>

        <div className="mx-6 border-t-2 border-dashed border-[#E3E6E8]" />

        {/* Details */}
        <dl className="px-6 py-4 flex flex-col gap-2.5">
          {rows.map(r => (
            <div key={r.label} className="flex items-baseline justify-between gap-4">
              <dt className="text-[13px] text-[#62676C] shrink-0">{r.label}</dt>
              <dd className={`text-[13.5px] font-semibold text-right truncate ${r.mono ? 'font-mono text-[12.5px] font-medium' : ''}`}>{r.value}</dd>
            </div>
          ))}
        </dl>
        {txHash && explorerUrl && !printable && (
          <a href={explorerUrl} target="_blank" rel="noreferrer"
            className="mx-6 mb-4 flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-[13px] font-semibold"
            style={{ background: '#EEF6F4', color: INK }}>
            View on explorer <ExternalLink className="size-3.5" />
          </a>
        )}

        <div className="mx-6 border-t-2 border-dashed border-[#E3E6E8]" />

        {/* MeshPort */}
        <div className="flex items-center justify-center gap-2.5 px-6 pt-4 pb-6">
          <MeshPortLogo className="size-7 !shadow-none" />
          <div className="leading-tight">
            <p className="text-[12.5px] font-semibold">Paid with USDC on MeshPort</p>
            <p className="text-[11.5px] text-[#8A9096]">meshport.xyz</p>
          </div>
        </div>
      </div>
    </div>
  )
}
