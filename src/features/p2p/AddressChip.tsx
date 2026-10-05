// features/p2p/AddressChip.tsx
//
// Shared, consistent way to show an on-chain address anywhere in the P2P
// admin console — signers, admin, pauser(s), investigator(s), connected
// wallet, dispute frozenBy/investigatedBy, event args. Previously every
// one of these was a raw full-length monospace string dropped straight
// into the page: it would overflow on mobile (no truncation, no wrap
// handling), and there was no way to actually USE the address (copy it to
// go look it up) without manually selecting 42 characters of text.

import { useState } from 'react'
import { Copy, Check } from 'lucide-react'

function shortAddr(a: string): string {
  return a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
}

export function AddressChip({ address, mono = true, size = 12.5, color }: { address: string; mono?: boolean; size?: number; color?: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      // Clipboard API can be unavailable (permissions, non-secure
      // context) — the address is still fully visible via the title
      // tooltip, so this is a nice-to-have, not required for the address
      // to be usable.
    }
  }

  return (
    <span
      title={address}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, maxWidth: '100%',
        fontFamily: mono ? 'monospace' : 'inherit', fontSize: size, color: color ?? 'var(--text-primary)',
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{shortAddr(address)}</span>
      <button
        onClick={copy}
        title={copied ? 'Copied' : 'Copy full address'}
        style={{ flexShrink: 0, display: 'inline-flex', background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: copied ? 'var(--success)' : 'var(--text-secondary)' }}
      >
        {copied ? <Check size={size - 1} /> : <Copy size={size - 1} />}
      </button>
    </span>
  )
}
