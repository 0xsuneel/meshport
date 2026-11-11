// src/components/wallet/WalletConfirmFrame.tsx
//
// The passcode step inside the wallet: a visible iframe of
// wallet-frame/confirm.html, where the person reads what they approve and
// types the passcode (or uses the fingerprint). The app learns only the
// outcome (lib/walletConfirm). When the wallet can't confirm here (an older
// wallet deployment, no passcode on this device yet, unreachable),
// `onUnavailable` hands the step back to the app's own keypad.

import { useEffect, useRef, useState } from 'react'
import type { ConfirmIntent, ConfirmRequest, ConfirmScope, ConfirmSummary } from '@/wallet/protocol'

export interface WalletConfirmRequest {
  /** The exact transaction (Pay) - the wallet decodes and binds it. */
  intent?: () => Promise<ConfirmIntent | null>
  /** A spend limit (lib/walletConfirm spendScope) - the wallet counts every signature against it. */
  scope?: ConfirmScope | null
  /** One exact signature request (WalletApprovalPrompt). */
  request?: ConfirmRequest | null
  summary: ConfirmSummary
}

export function WalletConfirmFrame({ request, onApproved, onUnavailable }: {
  request: WalletConfirmRequest
  onApproved: (token: string, viaBiometric: boolean) => void
  onUnavailable: () => void
}) {
  const [src, setSrc] = useState<string | null>(null)
  // About the page's height (card + dots + keypad) until it reports its own,
  // so the sheet doesn't jump when it does.
  const [height, setHeight] = useState(() => (typeof window !== 'undefined' && window.matchMedia?.('(max-height: 700px)').matches ? 356 : 400))
  const [shown, setShown] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const latest = useRef({ onApproved, onUnavailable })
  latest.current = { onApproved, onUnavailable }

  useEffect(() => {
    let done = false
    let approved = false
    let ticket: string | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    setSrc(null); setFailed(null); setShown(false)
    const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'

    const scope = request.scope ?? null
    const poll = async (address: string, intent: ConfirmIntent | null) => {
      if (done || !ticket) return
      try {
        const { confirmResult } = await import('@/wallet')
        const outcome = await confirmResult(ticket)
        if (done) return
        if (outcome.status === 'approved') {
          done = true
          approved = true // the screen signs with it next: closing the sheet must not drop it
          const { finishWalletConfirm } = await import('@/lib/walletConfirm')
          latest.current.onApproved(await finishWalletConfirm(address, ticket, { intent, scope }), outcome.viaBiometric)
          return
        }
        if (outcome.status === 'error') { setFailed(outcome.message); return }
        if (outcome.status === 'cancelled') return
      } catch { /* the frame is busy or reloading: ask again */ }
      timer = setTimeout(() => void poll(address, intent), 400)
    }

    ;(async () => {
      const { startWalletConfirm, noteConfirmUnsupported } = await import('@/lib/walletConfirm')
      const intent = request.intent ? await request.intent() : null
      if (done) return
      // Nothing the wallet can bind (a payment it couldn't build, no amount
      // known): the app's keypad, and each signature is confirmed on its own.
      if (!intent && !scope && !request.request) { latest.current.onUnavailable(); return }
      try {
        const started = await startWalletConfirm({ intent, scope, request: request.request, summary: request.summary }, theme)
        ticket = started.ticket
        if (done) { void import('@/wallet').then(m => m.cancelConfirm(started.ticket)); return }
        // A short phone: the page uses the app keypad's shorter keys, so the
        // whole step fits in the sheet (it accepts the passcode only while
        // fully in view).
        setSrc(started.url + (window.matchMedia?.('(max-height: 700px)').matches ? '&short=1' : ''))
        void poll(started.address, intent)
      } catch (e) {
        if (done) return
        const code = (e as { code?: string }).code
        if (code === 'unsupported') noteConfirmUnsupported()
        latest.current.onUnavailable()
      }
    })()

    const onMessage = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return
      const d = e.data as { type?: string; state?: string; height?: number } | null
      if (!d || d.type !== 'mp-confirm') return
      if (d.state === 'size' && typeof d.height === 'number') setHeight(Math.min(Math.max(d.height, 200), 900))
      if (d.state === 'ready') setShown(true)
    }
    window.addEventListener('message', onMessage)
    return () => {
      done = true
      if (timer) clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      if (ticket && !approved) void import('@/wallet').then(m => m.cancelConfirm(ticket!)).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  if (failed) {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <p role="alert" className="text-sm text-danger">{failed}</p>
        <button type="button" onClick={() => setAttempt(a => a + 1)}
          className="rounded-2xl px-5 py-3 text-[15px] font-bold text-white bg-brand active:scale-[0.98] transition-transform">
          Try again
        </button>
      </div>
    )
  }
  return (
    // Never squeezed by the sheet's column: a frame shorter than its page
    // scrolled inside, so the page was never fully in view and stayed locked.
    <div className="relative w-full" style={{ height, flexShrink: 0 }}>
      {!shown && <div className="absolute inset-0 rounded-2xl bg-surface mp-pulse" aria-hidden />}
      {src && (
        <iframe
          ref={frameRef}
          src={src}
          title="Confirm in your wallet"
          allow="publickey-credentials-get"
          referrerPolicy="no-referrer"
          className="block w-full border-0"
          style={{ height, colorScheme: 'normal', visibility: shown ? 'visible' : 'hidden' }}
        />
      )}
    </div>
  )
}
