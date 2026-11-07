// SecurePinPad - the passcode keypad served by the wallet frame's own origin
// (wallet-frame/confirm.html), in place of the app's keypad
// (docs/SECURE-APPROVALS.md). The frame draws what is being approved from
// the intent it was given and checks the passcode itself; this component
// only ever receives "approved" with a one-time ticket, which it hands to the
// screen's onComplete where the passcode used to go (verifyPasscode accepts
// it). The app never sees the digits.
//
// Fingerprint stays available as a button below (phase 2 moves it into the
// frame too). If the frame can't open a ticket (an older frame, no passcode
// there), onUnavailable lets PinSheet show the app's own keypad as before.

import { useEffect, useRef, useState } from 'react'
import { Fingerprint, ScanFace } from 'lucide-react'
import { FRAME_TICKET_PREFIX, type ApprovalIntent } from '@/wallet/protocol'
import { useAuthStore } from '@/store'
import { hasBiometricRegistered, unlockWithBiometric, biometricLabel, isBiometricSupported } from '@/lib/biometric'

const FRAME_SOURCES = new Set(['create', 'import-seed', 'import-privkey', 'social-auto'])

/** Whose passcode the frame checks for this account, or null (the app's own keypad then). */
export function secureWallet(): { owner: string; wallet: 'circle' | 'frame' } | null {
  const { walletAddress, walletSource, passcode } = useAuthStore.getState()
  if (!walletAddress || passcode !== 'frame:v1') return null
  if (walletSource === 'circle') return { owner: walletAddress, wallet: 'circle' }
  if (walletSource && FRAME_SOURCES.has(walletSource)) return { owner: walletAddress, wallet: 'frame' }
  return null
}

let capsPromise: Promise<boolean> | null = null
/** Whether this device's wallet frame has the keypad page (cached; an older frame doesn't). */
export function frameHasSecureKeypad(): Promise<boolean> {
  capsPromise ??= import('@/wallet/frameClient')
    .then(m => m.callWallet('session:capabilities', {} as Record<string, never>))
    .then(r => r.capabilities.includes('confirm'))
    .catch(() => { capsPromise = null; return false })
  return capsPromise
}

export function SecurePinPad({ intent, title, name, label, onChange, onComplete, onCancel, onUnavailable, biometricAvailable, autoBiometric = true }: {
  intent?: ApprovalIntent
  title: string
  name?: string
  label?: string
  /** The screen's passcode state: it gets the ticket, as PinKeypad hands it the digits. */
  onChange: (v: string) => void
  onComplete: (pin: string, viaBiometric?: boolean) => void
  onCancel: () => void
  onUnavailable: () => void
  biometricAvailable?: boolean
  autoBiometric?: boolean
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [drawn, setDrawn] = useState(false)
  const ticketRef = useRef<string | null>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const done = useRef(false)
  // Like PinKeypad: the value goes to the screen's state first, then - once
  // that render is in - the latest onComplete (screens read their own state).
  const completeRef = useRef(onComplete)
  completeRef.current = onComplete
  const finish = (value: string, viaBiometric: boolean) => {
    if (done.current) return
    done.current = true
    onChange(value)
    requestAnimationFrame(() => requestAnimationFrame(() => completeRef.current(value, viaBiometric)))
  }

  // A ticket for what this sheet approves; the keypad page draws it from the frame.
  useEffect(() => {
    let cancelled = false
    const who = secureWallet()
    if (!who) { onUnavailable(); return }
    void (async () => {
      try {
        const { callWallet, walletOrigin } = await import('@/wallet/frameClient')
        const { ticket } = await callWallet('confirm:open', {
          owner: who.owner, wallet: who.wallet, intent: intent ?? { kind: 'other' },
          title: title.slice(0, 60), name: name?.slice(0, 40), label: label?.slice(0, 80),
        })
        if (cancelled) return
        ticketRef.current = ticket
        const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
        setSrc(`${walletOrigin()}/confirm.html#t=${ticket}&theme=${theme}`)
      } catch {
        if (!cancelled) onUnavailable()
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The keypad page says: drawn, approved, cancelled (never the digits).
  useEffect(() => {
    if (!src) return
    let origin = ''
    void import('@/wallet/frameClient').then(m => { origin = m.walletOrigin() })
    const onMessage = (e: MessageEvent) => {
      if (!origin || e.origin !== origin || e.source !== frameRef.current?.contentWindow) return
      const d = (e.data ?? {}) as { type?: string; ticket?: string; drawn?: boolean; approved?: boolean; cancelled?: boolean }
      if (d.type !== 'mp-confirm' || d.ticket !== ticketRef.current) return
      if (d.drawn) setDrawn(true)
      if (d.cancelled) onCancel()
      if (d.approved) finish(FRAME_TICKET_PREFIX + d.ticket, false)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  // Fingerprint, as before (its passcode still opens in the app until phase 2).
  const walletAddress = useAuthStore(s => s.walletAddress)
  const biometricEnabled = useAuthStore(s => s.biometricEnabled)
  const storedHash = useAuthStore(s => s.passcode)
  const [bioOk, setBioOk] = useState(false)
  const [trying, setTrying] = useState(false)
  useEffect(() => {
    if (biometricAvailable === false || !biometricEnabled || !walletAddress || !hasBiometricRegistered(walletAddress)) return
    let cancelled = false
    void isBiometricSupported().then(ok => { if (!cancelled) setBioOk(ok) })
    return () => { cancelled = true }
  }, [biometricAvailable, biometricEnabled, walletAddress])
  const tryBiometric = async () => {
    if (!walletAddress || trying || done.current) return
    setTrying(true)
    const r = await unlockWithBiometric(walletAddress, storedHash ?? undefined)
    setTrying(false)
    if (r.ok) finish(r.passcode, true)
  }
  const autoTried = useRef(false)
  useEffect(() => {
    if (bioOk && autoBiometric && !autoTried.current) { autoTried.current = true; void tryBiometric() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bioOk])
  const BioIcon = biometricLabel() === 'Face ID' ? ScanFace : Fingerprint

  return (
    <div className="flex flex-col gap-3">
      <div className="relative w-full" style={{ height: 430 }}>
        {src && (
          <iframe
            ref={frameRef}
            src={src}
            title="Enter your passcode in the MeshPort wallet"
            referrerPolicy="no-referrer"
            className="absolute inset-0 w-full rounded-2xl border border-border"
            style={{ height: 430, colorScheme: 'normal', opacity: drawn ? 1 : 0, transition: 'opacity 160ms ease-out' }}
          />
        )}
        {!drawn && <div aria-hidden className="absolute inset-0 rounded-2xl bg-surface border border-border mp-pulse" />}
      </div>
      {bioOk && (
        <button type="button" onClick={() => void tryBiometric()} disabled={trying}
          className="flex items-center justify-center gap-2 rounded-2xl py-3 text-[14px] font-semibold text-brand-text bg-bg active:scale-[0.98] transition-transform">
          <BioIcon className="w-5 h-5" /> {trying ? `Waiting for ${biometricLabel()}…` : `Use ${biometricLabel()}`}
        </button>
      )}
    </div>
  )
}
