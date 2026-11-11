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
import { walletOrigin } from '@/wallet/frameClient'

export interface WalletConfirmRequest {
  /** The exact transaction (Pay) - the wallet decodes and binds it. */
  intent?: () => Promise<ConfirmIntent | null>
  /** A spend limit (lib/walletConfirm spendScope) - the wallet counts every signature against it. */
  scope?: ConfirmScope | null
  /** One exact signature request (WalletApprovalPrompt). */
  request?: ConfirmRequest | null
  summary: ConfirmSummary
}

// Chrome ignores touches on another site's page for half a second after it
// moves or changes size. The sheet waits this long with the page sitting
// still (out of sight) before showing it, so its keys work on the first tap.
const SETTLE_MS = 560

export function WalletConfirmFrame({ request, onApproved, onUnavailable, onUsable, waiting }: {
  request: WalletConfirmRequest
  onApproved: (token: string, viaBiometric: boolean) => void
  onUnavailable: () => void
  /** The page is drawn and has sat still long enough to take touches (or it
   *  failed and shows that): the sheet can be shown now. */
  onUsable?: () => void
  /** The page isn't usable yet: if the sheet is shown meanwhile, say so (faded keys, "Opening your wallet…"). */
  waiting?: boolean
}) {
  const [src, setSrc] = useState<string | null>(null)
  // About the page's height (card + dots + keypad) until it reports its own,
  // so the sheet doesn't jump when it does.
  const short = typeof window !== 'undefined' && !!window.matchMedia?.('(max-height: 700px)').matches
  // The page's own height once it reports it; until then the stand-in below
  // sets the height (it is the same layout).
  const [height, setHeight] = useState<number | null>(null)
  // The page's height, known ahead (its layout is the stand-in's): the frame
  // has its final size from the start, so nothing moves when the page reports
  // it - any move would restart Chrome's half second.
  const estimate = (short ? 357 : 415) - (request.summary.detail ? 0 : 13)
  const [shown, setShown] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const onFrameLoad = useRef<(() => void) | null>(null)
  const latest = useRef({ onApproved, onUnavailable, onUsable })
  latest.current = { onApproved, onUnavailable, onUsable }
  const boxRef = useRef<HTMLDivElement>(null)
  // How long each step of opening the wallet's page took on this phone
  // (wallet_events 'confirm_open'): sheet asked → page loaded → ready →
  // sized → request in → usable, and how often it moved meanwhile.
  const trace = useRef<{ t0: number; steps: Record<string, number>; moves: number; sizes: number; sent: boolean }>({ t0: performance.now(), steps: {}, moves: 0, sizes: 0, sent: false })
  const mark = (name: string) => { const t = trace.current; if (!(name in t.steps)) t.steps[name] = performance.now() - t.t0 }
  const sendTrace = (ok: boolean, error?: string) => {
    const t = trace.current
    if (t.sent) return
    t.sent = true
    const steps = { ...t.steps, moves: t.moves, sizes: t.sizes }
    ;(window as { __hlog?: (s: string) => void }).__hlog?.(`confirm_open ok=${ok} ${JSON.stringify(steps)}`)
    void import('@/lib/walletEvents').then(m => m.logWalletEvent({ event: 'confirm_open', ok, ms: performance.now() - t.t0, steps, error })).catch(() => {})
  }

  // Usable = drawn, sized, and its place on screen unchanged for SETTLE_MS
  // (counted from when it was laid out - only a later move starts it again).
  const live = shown && height !== null
  const liveRef = useRef(live)
  liveRef.current = live
  if (live) mark('live')
  // Closed (or failed) before it was usable: that is worth knowing too.
  useEffect(() => () => { if (performance.now() - trace.current.t0 > 1000) sendTrace(false, 'closed before usable') }, [])
  useEffect(() => {
    if (failed) { latest.current.onUsable?.(); return }
    let raf = 0, last = '', lastMove = performance.now(), told = false, prev = performance.now()
    const tick = () => {
      // The longest the app's screen was frozen meanwhile (heavy work on the
      // phone delays everything here, the sheet included).
      const n = performance.now()
      if (n - prev > (trace.current.steps.gap ?? 0)) trace.current.steps.gap = n - prev
      prev = n
      const r = boxRef.current?.getBoundingClientRect()
      const at = r ? `${r.left.toFixed(1)},${r.top.toFixed(1)},${r.width.toFixed(1)},${r.height.toFixed(1)}` : ''
      const now = performance.now()
      if (at !== last) { if (last && liveRef.current) trace.current.moves++; last = at; lastMove = now }
      if (liveRef.current && now - lastMove >= SETTLE_MS && !told) { told = true; mark('usable'); sendTrace(true); latest.current.onUsable?.(); return }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  // `live` too: the page turning visible (it is hidden until drawn) counts as
  // a change for Chrome just like a move - shown right after it, the first
  // one or two taps were dropped (measured: 4-5 of 6 reached the page on a
  // slow phone). The settle time restarts from that moment.
  }, [attempt, failed, src, live])

  useEffect(() => {
    let done = false
    let approved = false
    let ticket: string | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let fallback: ReturnType<typeof setTimeout> | null = null
    let ready = false
    // A wallet page from before slots (the two sites deploying a moment
    // apart) loads but never says it's ready: then it is opened by ticket -
    // at once if the ticket is known, else as soon as it is.
    let ticketUrl: string | null = null
    let oldPage = false
    let switched = false
    const byTicket = () => { if (!done && !ready && !switched && ticketUrl) { switched = true; mark('byTicket'); setSrc(ticketUrl) } }
    onFrameLoad.current = () => {
      if (ready || switched) return
      // 2 s, not 0.5: on a busy phone the page's "ready" can land well after
      // its load event, and switching a live page to the ticket address
      // throws away a page that was about to show.
      setTimeout(() => { if (!done && !ready) { oldPage = true; byTicket() } }, 2000)
    }
    setFailed(null); setShown(false); setHeight(null)
    const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
    // The wallet's page opens now, by a slot name, before the request exists:
    // it shows the app's summary and takes the passcode while the wallet
    // builds the request (it never comes through the app). A short phone
    // gets the app keypad's shorter keys, so the whole step fits.
    const slot = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')
    const view = `&theme=${theme}${short ? '&short=1' : ''}`
    setSrc(`${walletOrigin()}/confirm.html#slot=${slot}${view}&s=${encodeURIComponent(JSON.stringify(request.summary))}`)

    const scope = request.scope ?? null
    // The wallet's page says "approved" the moment the passcode is checked:
    // ask the wallet for the result then, not on the next 400 ms look. The
    // result itself still only comes from the wallet (confirmResult).
    let lookNow: (() => void) | null = null
    let looking = false
    let again = false // "approved" came while a look was on its way: look again at once
    const poll = async (address: string, intent: ConfirmIntent | null) => {
      if (done || !ticket) return
      lookNow = () => {
        if (done) return
        if (looking) { again = true; return }
        if (timer) { clearTimeout(timer); timer = null }
        void poll(address, intent)
      }
      looking = true
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
      finally { looking = false }
      if (done) return
      const soon = again
      again = false
      timer = setTimeout(() => void poll(address, intent), soon ? 0 : 400)
    }

    ;(async () => {
      const { startWalletConfirm, noteConfirmUnsupported } = await import('@/lib/walletConfirm')
      const intent = request.intent ? await request.intent() : null
      if (done) return
      // Nothing the wallet can bind (a payment it couldn't build, no amount
      // known): the app's keypad, and each signature is confirmed on its own.
      if (!intent && !scope && !request.request) { latest.current.onUnavailable(); return }
      try {
        const started = await startWalletConfirm({ intent, scope, request: request.request, summary: request.summary }, theme, slot)
        ticket = started.ticket
        mark('begun')
        if (done) { void import('@/wallet').then(m => m.cancelConfirm(started.ticket)); return }
        ticketUrl = started.url + (short ? '&short=1' : '')
        if (oldPage) byTicket()
        // No load event seen either way: the same, a little later.
        else if (!ready) fallback = setTimeout(byTicket, 2500)
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
      if (d.state === 'size' && typeof d.height === 'number') { mark('size'); trace.current.sizes++; setHeight(Math.min(Math.max(d.height, 120), 900)) }
      if (d.state === 'ready') { mark('ready'); ready = true; setShown(true) }
      if (d.state === 'approved') lookNow?.()
    }
    window.addEventListener('message', onMessage)
    return () => {
      done = true
      if (timer) clearTimeout(timer)
      if (fallback) clearTimeout(fallback)
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
  // The page shows once it is drawn AND has said how tall it is ('ready'
  // comes a frame before its size): never a frame with neither.
  return (
    // Never squeezed by the sheet's column: a frame shorter than its page
    // scrolled inside, so the page was never fully in view and stayed locked.
    <div ref={boxRef} className="relative w-full" style={{ height: live ? height! : estimate, flexShrink: 0 }}>
      {/* On the first frame: the same card, dots and keys the wallet's page
          draws, so the sheet never opens blank. It takes no input - the
          passcode is only ever typed in the wallet's page, which loads on top
          of it, pixel for pixel, and replaces it. */}
      {!live && <ConfirmStandIn summary={request.summary} short={short} waiting={waiting} />}
      {src && (
        <iframe
          // A new address is a new page: the slot and ticket addresses differ
          // only after '#', which on its own wouldn't reload it.
          key={src}
          ref={frameRef}
          src={src}
          title="Confirm in your wallet"
          onLoad={() => { mark('load'); onFrameLoad.current?.() }}
          allow="publickey-credentials-get"
          referrerPolicy="no-referrer"
          className="block w-full border-0"
          style={{ position: 'absolute', left: 0, top: 0, height: height ?? '100%', colorScheme: 'normal', visibility: live ? 'visible' : 'hidden' }}
        />
      )}
    </div>
  )
}

// ── The stand-in: wallet-frame/src/confirm.css, drawn by the app ────────────
// Same sizes as the wallet's page (PinSheet's card, PinKeypad's keys), so the
// swap to the real page doesn't move anything.
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del']
export function ConfirmStandIn({ summary, short, waiting }: { summary: ConfirmSummary; short: boolean; waiting?: boolean }) {
  const keyH = short ? 48 : 56
  const muted = { fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 } as const
  const clip = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const
  return (
    <div aria-hidden style={{ pointerEvents: 'none', userSelect: 'none', lineHeight: 1.4, fontSize: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, borderRadius: 18, background: 'var(--bg)', padding: '14px 16px', textAlign: 'left' }}>
        <div style={{ width: 44, height: 44, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 18, fontWeight: 800, color: 'var(--brand-text)', background: 'color-mix(in srgb, var(--brand) 16%, transparent)' }}>
          {summary.name.trim().charAt(0).toUpperCase() || '?'}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ ...muted, ...clip }}>{summary.label}</p>
          <p style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.4, ...clip }}>{summary.name}</p>
          {summary.detail && <p style={{ ...muted, ...clip }}>{summary.detail}</p>}
        </div>
        {summary.amount && (
          <div style={{ textAlign: 'right', flexShrink: 0, maxWidth: '55%' }}>
            <p style={{ margin: 0, fontSize: summary.amount.length > 9 ? 16 : 22, fontWeight: 800, letterSpacing: summary.amount.length > 9 ? 0 : '-0.5px',
              lineHeight: 1.25, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>{summary.amount}</p>
            {summary.unit && <p style={muted}>{summary.unit}</p>}
          </div>
        )}
      </div>
      <div style={{ marginTop: short ? 20 : 28, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 12, height: 14 }}>
          {Array.from({ length: 6 }, (_, i) => <span key={i} style={{ width: 14, height: 14, borderRadius: '50%', border: '1.5px solid var(--border)', boxSizing: 'border-box' }} />)}
        </div>
        {/* Only seen when the sheet had to open before the wallet's page was
            ready (a very slow connection): keys faded, and why. */}
        <div style={{ minHeight: 18, margin: short ? '1px 0' : '7px 0', fontSize: 13, lineHeight: 1.4, color: 'var(--text-secondary)', textAlign: 'center' }}>{waiting ? 'Opening your wallet…' : ''}</div>
        <div style={{ width: '100%', maxWidth: 320, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: short ? 8 : 10, opacity: waiting ? 0.4 : 1 }}>
          {KEYS.map((k, i) => k === '' ? <span key={i} /> : (
            <span key={i} style={{ height: keyH, borderRadius: 14, border: '1px solid var(--border)', background: 'var(--surface)', boxSizing: 'border-box',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 600, lineHeight: 1,
              color: k === 'del' ? 'var(--text-secondary)' : 'var(--text-primary)' }}>
              {k === 'del'
                ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 4H8l-7 8 7 8h13a2 2 0 002-2V6a2 2 0 00-2-2z" /><line x1="18" y1="9" x2="12" y2="15" /><line x1="12" y1="9" x2="18" y2="15" /></svg>
                : k}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
