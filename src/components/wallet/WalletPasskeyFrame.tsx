// src/components/wallet/WalletPasskeyFrame.tsx
//
// Runs a wallet passkey ceremony (create the Safe's passkey owner, or sign a
// hash with it) in a visible iframe of wallet-frame/passkey.html. Browsers
// only allow WebAuthn in a cross-origin frame after a tap inside it, so the
// person taps the frame's button; the app only learns the outcome - a public
// key or a Safe-format signature.

import { useEffect, useState } from 'react'
import { awaitPasskey, beginPasskey, type PasskeyOutcome, type PasskeyRequest } from '@/wallet'

export function WalletPasskeyFrame({ request, height = 120, onDone }: {
  request: PasskeyRequest
  height?: number
  onDone: (outcome: Exclude<PasskeyOutcome, { status: 'pending' }>) => void
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    const abort = new AbortController()
    setSrc(null); setFailed(null)
    const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
    beginPasskey(request, theme)
      .then(({ ticket, url }) => {
        if (abort.signal.aborted) return
        setSrc(url)
        return awaitPasskey(ticket, { signal: abort.signal }).then(o => { if (!abort.signal.aborted) onDone(o) })
      })
      .catch((e: Error) => { if (!abort.signal.aborted) setFailed(e.message || "Couldn't start Face ID") })
    return () => abort.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(request)])

  if (failed) return <p role="alert" className="text-sm text-danger">{failed}</p>
  if (!src) return <div className="rounded-2xl bg-surface border border-border animate-pulse" style={{ height }} />
  return (
    <iframe
      src={src}
      title="Confirm with your passkey"
      allow="publickey-credentials-create; publickey-credentials-get"
      referrerPolicy="no-referrer"
      className="w-full rounded-2xl border border-border"
      style={{ height, colorScheme: 'normal' }}
    />
  )
}
