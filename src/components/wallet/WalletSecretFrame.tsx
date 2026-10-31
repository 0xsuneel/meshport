// src/components/wallet/WalletSecretFrame.tsx
//
// Shows the wallet's recovery phrase or private key without the app ever
// holding it: a visible iframe of wallet-frame/reveal.html on the wallet
// origin, opened with a one-time ticket. The app sees only the iframe's
// pixels; copy / clipboard happen inside the frame.
//
// No flicker: the placeholder stays up, with the frame invisible under it,
// until the reveal page says it has drawn (a 'mp-reveal' message - it carries
// no secret), then the frame fades in. Before that the page can briefly be
// unstyled, "Opening…" or in the wrong theme; none of that is seen.

import { useEffect, useRef, useState } from 'react'
import { revealUrl, walletOrigin, WalletFrameError } from '@/wallet'

/** A reveal page from before the 'mp-reveal' message: shown this long after it loads. */
const LEGACY_SHOW_MS = 900

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
  const [drawn, setDrawn] = useState(false)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const h = height ?? (what === 'mnemonic' ? 260 : 150)

  useEffect(() => {
    let cancelled = false
    setSrc(null); setFailed(null); setDrawn(false)
    const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
    revealUrl(address, what, { passcode, theme })
      .then(url => { if (!cancelled) setSrc(url) })
      .catch((e: Error) => { if (!cancelled) { setFailed(e.message || "Couldn't open it"); onError?.(e) } })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, what, passcode])

  // The reveal page says when it has drawn the secret (or its error).
  useEffect(() => {
    if (!src) return
    const origin = walletOrigin()
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frameRef.current?.contentWindow) return
      if ((e.data as { type?: string } | null)?.type === 'mp-reveal') setDrawn(true)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [src])

  if (failed) return <p role="alert" className="text-sm text-danger">{failed}</p>
  return (
    <div className="relative w-full" style={{ height: h }}>
      {src && (
        <iframe
          ref={frameRef}
          src={src}
          title={what === 'mnemonic' ? 'Your recovery phrase' : 'Your private key'}
          allow="clipboard-write"
          referrerPolicy="no-referrer"
          // Older reveal pages never send the message: show them shortly after they load.
          onLoad={() => setTimeout(() => setDrawn(true), LEGACY_SHOW_MS)}
          className="absolute inset-0 w-full rounded-2xl border border-border"
          style={{ height: h, colorScheme: 'normal', opacity: drawn ? 1 : 0, transition: 'opacity 160ms ease-out' }}
        />
      )}
      {!drawn && (
        <div aria-hidden className="absolute inset-0 rounded-2xl bg-surface border border-border mp-pulse" />
      )}
    </div>
  )
}
