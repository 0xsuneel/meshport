/**
 * ReceiptCard — receipt look for screenshot or print.
 * When printable=true, adds class print-only-area so @media print shows it.
 */
import React from 'react'
import { ExternalLink } from 'lucide-react'

export interface ReceiptCardProps {
  storeName: string
  handle: string
  amount: string
  from: string
  chainLabel: string
  order?: string
  time: string      // ISO
  txHash?: string
  refunded?: boolean
  printable?: boolean
}

export function ReceiptCard({
  storeName,
  handle,
  amount,
  from,
  chainLabel,
  order,
  time,
  txHash,
  refunded = false,
  printable = false,
}: ReceiptCardProps) {
  return (
    <div
      className={`rounded-3xl bg-white text-black overflow-hidden shadow-lg w-full max-w-xs mx-auto ${
        printable ? 'print-only-area' : ''
      }`}
      style={{ fontFamily: 'DM Sans, sans-serif' }}
    >
      {/* Store header */}
      <div className="flex flex-col items-center gap-1 pt-8 pb-5 px-6 bg-gray-50 border-b border-gray-100">
        <div className="size-12 rounded-2xl bg-gray-200 flex items-center justify-center mb-1">
          <span className="text-xl font-bold text-gray-700">
            {storeName.trim()[0]?.toUpperCase() ?? 'S'}
          </span>
        </div>
        <p className="font-bold text-base">{storeName}</p>
        <p className="text-xs text-gray-400">{handle}</p>
      </div>

      {/* Amount */}
      <div className="flex flex-col items-center py-6 gap-1">
        {refunded && (
          <span className="text-[10px] font-bold uppercase tracking-wider text-red-500 mb-1">
            Refunded
          </span>
        )}
        <p
          className={`text-4xl font-bold tabular-nums ${refunded ? 'text-red-500 line-through opacity-60' : 'text-black'}`}
          style={{ fontFamily: 'Space Grotesk, sans-serif' }}
        >
          {amount}
        </p>
        <p className="text-xs text-gray-400">
          {new Date(time).toLocaleString([], {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
          })}
        </p>
      </div>

      {/* Dashed divider */}
      <div className="mx-6 border-t border-dashed border-gray-300 my-1" />

      {/* Details */}
      <div className="px-6 py-5 flex flex-col gap-3">
        {[
          { label: 'From',    value: from },
          { label: 'Network', value: chainLabel },
          ...(order ? [{ label: 'Order', value: order }] : []),
          ...(txHash ? [{ label: 'Tx hash', value: `${txHash.slice(0, 12)}…${txHash.slice(-6)}` }] : []),
        ].map(({ label, value }) => (
          <div key={label} className="flex items-center justify-between">
            <span className="text-xs text-gray-400">{label}</span>
            <span className="text-xs font-medium text-gray-700 font-mono text-right max-w-[60%] truncate">
              {value}
            </span>
          </div>
        ))}
      </div>

      {/* Explorer link */}
      {txHash && (
        <a
          href={`https://arcscan.io/tx/${txHash}`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-center gap-1 text-xs text-blue-600 pb-4"
        >
          View on explorer <ExternalLink className="size-3" />
        </a>
      )}

      {/* Dashed divider */}
      <div className="mx-6 border-t border-dashed border-gray-300 my-1" />

      {/* Footer */}
      <div className="flex flex-col items-center py-5 gap-1">
        <p className="text-[10px] text-gray-400">Paid with USDC on MeshPort</p>
        <p className="text-[10px] text-gray-300">meshport.app</p>
      </div>
    </div>
  )
}
