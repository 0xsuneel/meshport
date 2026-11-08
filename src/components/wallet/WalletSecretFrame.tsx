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
/** Not on screen after this long: explain, and offer Try again. */
const SLOW_MS = 15_000

export function WalletSecretFrame({ address, what, passcode, height, onError, onVerified }: {
  address: string
  /** 'verify': the backup check (tap the right words) - the phrase isn't shown. */
  what: 'mnemonic' | 'privateKey' | 'verify'
  /** The passcode just entered: the frame checks it before showing either secret. */
  passcode?: string
  height?: number
  onError?: (e: WalletFrameError | Error) => void
  /** 'verify': the person picked the right words (the page says only that). */
  onVerified?: () => void
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [drawn, setDrawn] = useState(false)
  // Still not shown after SLOW_MS (8 Nov: on a very slow mobile connection the
  // box just sat blank): say so, and offer to try again.
  const [slow, setSlow] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const onVerifiedRef = useRef(onVerified)
  onVerifiedRef.current = onVerified
  const h = height ?? (what === 'mnemonic' ? 260 : what === 'verify' ? 480 : 150)
  const label = what === 'privateKey' ? 'private key' : what === 'verify' ? 'backup check' : 'recovery phrase'

  useEffect(() => {
    if (drawn || failed) { setSlow(false); return }
    const t = setTimeout(() => setSlow(true), SLOW_MS)
    return () => clearTimeout(t)
  }, [drawn, failed, attempt])

  useEffect(() => {
    let cancelled = false
    setSrc(null); setFailed(null); setDrawn(false); setSlow(false)
    const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
    revealUrl(address, what, { passcode, theme })
      .then(url => { if (!cancelled) setSrc(url) })
      .catch((e: Error) => { if (!cancelled) { setFailed(e.message || "Couldn't open it"); onError?.(e) } })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, what, passcode, attempt])

  // The reveal page says when it has drawn the secret (or its error).
  useEffect(() => {
    if (!src) return
    const origin = walletOrigin()
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frameRef.current?.contentWindow) return
      const d = e.data as { type?: string; ok?: boolean } | null
      if (d?.type === 'mp-reveal') setDrawn(true)
      if (d?.type === 'mp-verify' && d.ok === true) onVerifiedRef.current?.()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [src])

  const retry = <button type="button" onClick={() => setAttempt(a => a + 1)}
    className="mt-1 px-4 py-2 rounded-xl bg-brand text-white text-sm font-semibold">Try again</button>
  if (failed) return (
    <div role="alert" className="flex flex-col items-center gap-2 text-center p-4 rounded-2xl border border-border">
      <p className="text-sm text-danger">{failed}</p>{retry}
    </div>
  )
  return (
    <div className="relative w-full" style={{ height: h }}>
      {src && (
        <iframe
          ref={frameRef}
          src={src}
          title={what === 'mnemonic' ? 'Your recovery phrase' : what === 'verify' ? 'Check your backup' : 'Your private key'}
          allow="clipboard-write"
          referrerPolicy="no-referrer"
          // Older reveal pages never send the message: show them shortly after they load.
          onLoad={() => setTimeout(() => setDrawn(true), LEGACY_SHOW_MS)}
          className="absolute inset-0 w-full rounded-2xl border border-border"
          style={{ height: h, colorScheme: 'normal', opacity: drawn ? 1 : 0, transition: 'opacity 160ms ease-out' }}
        />
      )}
      {!drawn && (
        <div className="absolute inset-0 rounded-2xl bg-surface border border-border flex flex-col items-center justify-center gap-2 p-4 text-center">
          {slow ? (
            <>
              <p className="text-sm text-text-primary font-semibold">Still opening your {label}…</p>
              <p className="text-xs text-text-secondary">Your connection looks slow. Keep this screen open, or try again.</p>
              {retry}
            </>
          ) : (
            <p className="text-sm text-text-secondary mp-pulse" role="status">Opening your {label}…</p>
          )}
        </div>
      )}
    </div>
  )
}
