// Receive → Solana: this account's Solana (devnet) address and USDC balance
// (docs/SOLANA.md). Shown only to Privy accounts once their Solana wallet
// exists; nothing renders otherwise.

import { useState } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { copyToClipboard } from '@/lib/utils'
import { solanaExplorerUrl } from '@/lib/solana'
import { useUIStore } from '@/store'
import { useSolanaWallet } from '@/wallet/useSolanaWallet'

export function SolanaReceiveCard() {
  const { address, usdc } = useSolanaWallet()
  const { showToastMessage } = useUIStore()
  const [copied, setCopied] = useState(false)
  if (!address) return null

  const copy = async () => {
    const ok = await copyToClipboard(address)
    showToastMessage(ok ? 'Solana address copied' : 'Could not copy the address', ok ? 'success' : 'error')
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000) }
  }

  return (
    <div className="w-full bg-surface border border-border rounded-2xl p-4 space-y-3" style={{ maxWidth: 340, boxSizing: 'border-box' }}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-text-primary">Solana <span className="text-xs font-normal text-text-secondary">· devnet</span></p>
        <p className="text-sm font-semibold text-text-primary">{usdc ?? '…'} <span className="text-xs font-normal text-text-secondary">USDC</span></p>
      </div>
      <button onClick={copy} className="w-full flex items-center gap-2 text-left active:opacity-70" aria-label="Copy Solana address">
        <span className="flex-1 min-w-0 text-xs font-mono text-text-secondary break-all">{address}</span>
        {copied ? <Check className="w-4 h-4 text-success flex-shrink-0" /> : <Copy className="w-4 h-4 text-text-secondary flex-shrink-0" />}
      </button>
      <p className="text-xs text-text-secondary">Receive USDC on Solana at this address. Only send Solana USDC here.</p>
      <a href={solanaExplorerUrl('address', address)} target="_blank" rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs text-accent-text">
        View on Solana Explorer <ExternalLink className="w-3 h-3" />
      </a>
    </div>
  )
}
