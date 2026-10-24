// src/components/wallet/WalletSecretFrame.tsx
//
// Shows the wallet's recovery phrase or private key without the app ever
// holding it: a visible iframe of wallet-frame/reveal.html on the wallet
// origin, opened with a one-time ticket. The app sees only the iframe's
// pixels; copy / clipboard happen inside the frame.

import { useEffect, useState } from 'react'
import { revealUrl, WalletFrameError } from '@/wallet'

export function WalletSecretFrame({ address, what, passcode, height, onError }: {
  address: string
  what: 'mnemonic' | 'privateKey'
  /** Needed for the recovery phrase (it's kept passcode-encrypted in the frame). */
  passcode?: string
  height?: number
  onError?: (e: WalletFrameError | Error) => void
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSrc(null); setFailed(null)
    const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
    revealUrl(address, what, { passcode, theme })
      .then(url => { if (!cancelled) setSrc(url) })
      .catch((e: Error) => { if (!cancelled) { setFailed(e.message || "Couldn't open it"); onError?.(e) } })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, what, passcode])

  if (failed) return <p role="alert" className="text-sm text-danger">{failed}</p>
  if (!src) return <div className="rounded-2xl bg-surface border border-border animate-pulse" style={{ height: height ?? (what === 'mnemonic' ? 260 : 150) }} />
  return (
    <iframe
      src={src}
      title={what === 'mnemonic' ? 'Your recovery phrase' : 'Your private key'}
      allow="clipboard-write"
      referrerPolicy="no-referrer"
      className="w-full rounded-2xl border border-border"
      style={{ height: height ?? (what === 'mnemonic' ? 260 : 150), colorScheme: 'normal' }}
    />
  )
}
