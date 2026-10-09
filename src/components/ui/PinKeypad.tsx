// PinKeypad - circular numeric keypad with dot progress indicator.
// Auto-calls onComplete when all digits are entered.
//
// Also the single integration point for transaction-approval biometric
// unlock - 9 pages across the app (Send, Swap, Multichain Send/Claim,
// Chat, Contacts, Bulk Payout, Profile) already share this one component,
// so wiring biometric in here covers all of them at once rather than
// repeating the same logic 9 times. On a successful OS biometric check,
// this calls onChange with the real decrypted passcode, which every
// caller already treats identically to the user having typed it manually
// - no caller-side changes needed, they already verify whatever value
// arrives against the stored passcode hash.
//
// onComplete's second argument, viaBiometric, tells the caller WHICH of
// those two paths just happened, so callers that show something
// biometric-specific after success (PaySendPage/ChatPage's paid-flash icon)
// know whether to. tryBiometric() records this in a ref (not state - it
// has to be readable synchronously the instant the pin fills, with zero
// risk of a stale render) the moment the OS check succeeds, right before
// onChange(pc); handleKey's manual path clears that ref back to false on
// every ordinary keypress/delete, so a manual entry can never be
// misreported as biometric even if a biometric attempt was made earlier
// in the same session on this same keypad instance.
import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Fingerprint, ScanFace } from 'lucide-react'
import { useAuthStore } from '@/store'
import { hasBiometricRegistered, verifyBiometricAndGetPasscode, biometricLabel, isBiometricSupported } from '@/lib/biometric'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { hapticError } from '@/lib/feedback'
import { BiometricFirst } from './BiometricFirst'

interface PinKeypadProps {
  value: string
  onChange: (val: string) => void
  length?: number
  error?: boolean
  shake?: boolean
  onComplete?: (pin: string, viaBiometric?: boolean) => void
  accentFrom?: string
  accentTo?: string
  // Revived - previously declared but never actually wired to anything
  // (see git history / the file this replaced). Both now optional and
  // both default to the real, live check below if omitted, so existing
  // callers that don't pass these get real biometric support for free;
  // a caller can still pass biometricAvailable={false} to explicitly
  // suppress it for a specific screen if that's ever needed.
  onBiometric?: () => void
  biometricAvailable?: boolean
  /** Open the fingerprint / Face ID prompt by itself when the pad appears
   *  (default on). Off where the pad isn't asking for the current passcode,
   *  e.g. choosing a new one. */
  autoBiometric?: boolean
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del']

export function PinKeypad({
  value,
  onChange,
  length = 6,
  error,
  shake,
  onComplete,
  accentFrom = 'var(--brand)',
  accentTo = 'var(--brand)',
  onBiometric,
  biometricAvailable,
  autoBiometric = true,
}: PinKeypadProps) {
  // Wrong PIN: two short knocks along with the shake / red dots.
  useEffect(() => { if (shake || error) hapticError() }, [shake, error])
  const completedRef = useRef(false)
  const viaBiometricRef = useRef(false)
  const [biometricTrying, setBiometricTrying] = useState(false)
  // Desktop users type on a physical keyboard - the tap-grid below is a
  // mobile-only affordance. Same value/onChange/onComplete contract either
  // way, so every caller of this component needs zero changes.
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const walletAddress = useAuthStore(s => s.walletAddress)
  const biometricEnabled = useAuthStore(s => s.biometricEnabled)
  const storedPasscodeHash = useAuthStore(s => s.passcode)
  const label = biometricLabel()
  const Icon = label === 'Face ID' ? ScanFace : Fingerprint

  // The doc comment above promised callers "the real, live check" by
  // default, but nothing here ever actually called it - biometricAvailable
  // being merely !== false meant the key rendered whenever a credential had
  // ever been registered, with zero regard for whether this device/browser
  // can currently do a platform biometric check at all. On platforms where
  // that capability is flaky (iOS Safari inside an installed/home-screen
  // PWA vs. a regular Safari tab, or a desktop machine with no Windows
  // Hello/Touch ID configured), that showed a key that reliably went
  // nowhere: verifyBiometricAndGetPasscode's failure is silent by design
  // (see its own comment - cancelling is normal), so the only visible
  // symptom was "biometric doesn't work here," with no error to explain
  // why. Checked live, same as EnableBiometricPage already does.
  // null until the live probe answers: the key shows meanwhile (as before),
  // but the automatic prompt below waits for a real yes.
  const [liveSupported, setLiveSupported] = useState<boolean | null>(null)
  useEffect(() => {
    if (biometricAvailable === false) return // caller already opted out - no need to probe
    let cancelled = false
    isBiometricSupported().then(ok => { if (!cancelled) setLiveSupported(ok) })
    return () => { cancelled = true }
  }, [biometricAvailable])

  const biometricReady =
    biometricAvailable !== false &&
    biometricEnabled &&
    !!walletAddress &&
    hasBiometricRegistered(walletAddress)
  const canUseBiometric = biometricReady && liveSupported !== false

  // Biometric on (phone) → fingerprint / Face ID first: the number pad only
  // appears once the scan fails or is cancelled, or on "Use passcode".
  const [mode, setMode] = useState<'bio' | 'pin'>(() =>
    autoBiometric && biometricReady && !isDesktop ? 'bio' : 'pin')
  // The prompt is about to open by itself (below): show "Waiting for…" from
  // the first frame instead of "Tap to use…" flipping as the sheet appears.
  const [autoPending, setAutoPending] = useState(() => mode === 'bio' && typeof document !== 'undefined' && document.visibilityState === 'visible')
  useEffect(() => { if (liveSupported === false) { setMode('pin'); setAutoPending(false) } }, [liveSupported])
  // A wrong passcode (e.g. a stale one from biometrics) → let them type.
  useEffect(() => { if (error || shake) { setMode('pin'); setBiometricTrying(false); setAutoPending(false) } }, [error, shake])
  // A screen that clears a fingerprint-filled passcode (without an error)
  // gets the fingerprint button back.
  useEffect(() => { if (!value && viaBiometricRef.current) setBiometricTrying(false) }, [value])

  const tryBiometric = async () => {
    if (!walletAddress || biometricTrying) return
    setBiometricTrying(true)
    setAutoPending(false)
    const pc = await verifyBiometricAndGetPasscode(walletAddress, storedPasscodeHash ?? undefined)
    // Accepted: stay on "Waiting for…" while the sheet closes - switching
    // back to "Tap to use…" for that moment read like the scan had failed.
    if (!pc) setBiometricTrying(false)
    // A cancelled/failed check just leaves the keypad ready for manual
    // entry - no error shown, cancelling is a normal choice here.
    if (pc) {
      viaBiometricRef.current = true
      onBiometric?.() // optional notification hook for a caller that wants one
      onChange(pc)
    } else {
      setMode('pin')
    }
  }

  // Biometric enabled → the fingerprint / Face ID prompt opens by itself as
  // soon as the pad appears (unlock and every transaction approval). If the
  // scan fails or is cancelled - or the browser refuses a prompt nobody
  // tapped for (iOS Safari can) - nothing else happens: the PIN pad is
  // already on screen and the fingerprint key stays there to try again.
  // Once per pad, never after the person has started typing, and only while
  // the page is actually visible.
  const autoTriedRef = useRef(false)
  const valueRef = useRef(value)
  valueRef.current = value
  const tryBiometricRef = useRef(tryBiometric)
  tryBiometricRef.current = tryBiometric
  // Don't wait for the capability probe: the prompt opens at once, and if
  // the device can't do it the call just fails into the passcode pad.
  const canAuto = autoBiometric && biometricReady && liveSupported !== false
  useEffect(() => {
    if (!canAuto) { setAutoPending(false); return }
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = () => {
      if (autoTriedRef.current || valueRef.current.length > 0) { setAutoPending(false); return }
      autoTriedRef.current = true
      tryBiometricRef.current()
    }
    // Straight away: the fingerprint view is what's on screen meanwhile.
    const schedule = () => { timer = setTimeout(run, 0) }
    const onVisible = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', onVisible); schedule() } }
    if (document.visibilityState === 'visible') schedule()
    else document.addEventListener('visibilitychange', onVisible)
    return () => { if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [canAuto])

  const handleKey = (key: string) => {
    if (key === '') return
    // Any ordinary manual keypress means whatever's being entered now is
    // manual, even if a biometric attempt happened earlier in this same
    // keypad's lifetime (e.g. user cancelled biometric, then typed).
    viaBiometricRef.current = false
    if (key === 'del') {
      completedRef.current = false
      onChange(value.slice(0, -1))
      return
    }
    if (value.length < length) {
      onChange(value + key)
    }
  }

  // Auto-fire onComplete when pin reaches full length
  useEffect(() => {
    if (value.length === length && !completedRef.current && onComplete) {
      completedRef.current = true
      const viaBiometric = viaBiometricRef.current
      // Fire right after the frame that paints the last dot filled (two
      // rAFs ≈ one paint) instead of a fixed 200ms - that delay sat on the
      // critical path of every Chat Pay / passcode confirm.
      requestAnimationFrame(() => requestAnimationFrame(() => onComplete(value, viaBiometric)))
    }
    if (value.length < length) {
      completedRef.current = false
    }
  }, [value, length, onComplete])

  if (mode === 'bio' && !isDesktop) {
    return (
      <div className="w-full">
        {/* Same height as dots (46) + number pad (4×56 + 3×10) */}
        <BiometricFirst Icon={Icon} label={label} trying={biometricTrying || autoPending} onTry={tryBiometric}
          onUsePasscode={() => { setAutoPending(false); setMode('pin') }} height={300} />
      </div>
    )
  }

  return (
    <div className="w-full">
      {/* Dot progress indicators */}
      <motion.div
        className="flex items-center justify-center gap-3 mb-8"
        animate={shake ? { x: [0, -8, 8, -8, 8, 0] } : { x: 0 }}
        transition={{ duration: 0.4 }}
      >
        {Array.from({ length }).map((_, i) => {
          const filled = i < value.length
          return (
            <div
              key={i}
              className="rounded-full transition-all duration-150"
              style={{
                width: '14px',
                height: '14px',
                background: filled
                  ? error
                    ? 'var(--danger)'
                    : `linear-gradient(135deg, ${accentFrom}, ${accentTo})`
                  : 'transparent',
                border: filled ? 'none' : '1.5px solid var(--border)',
              }}
            />
          )
        })}
      </motion.div>

      {isDesktop ? (
        /* Desktop - a real keyboard already exists, so no on-screen grid.
           Same onChange(val)/onComplete contract as the mobile branch: this
           just sanitizes typed input to digits and caps it at `length`. */
        <div className="flex items-center gap-3 max-w-[320px] mx-auto">
          <input
            type="password"
            inputMode="numeric"
            autoFocus
            value={value}
            onChange={e => onChange(e.target.value.replace(/\D/g, '').slice(0, length))}
            style={{
              flex: 1, height: 52, borderRadius: 14, padding: '0 16px',
              background: 'var(--surface)', border: `1px solid ${error ? 'var(--danger)' : 'var(--border)'}`,
              color: 'var(--text-primary)', fontSize: 20, letterSpacing: '6px', textAlign: 'center',
              outline: 'none',
            }}
            aria-label="Passcode"
          />
          {canUseBiometric && (
            <button
              onClick={tryBiometric}
              disabled={biometricTrying}
              className="flex items-center justify-center mp-key"
              style={{ width: 52, height: 52, borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--brand-text)', flexShrink: 0 }}
              aria-label={`Use ${label}`}
            >
              <motion.div
                animate={biometricTrying ? { scale: [1, 1.18, 1], opacity: [1, 0.55, 1] } : { scale: 1, opacity: 1 }}
                transition={biometricTrying ? { duration: 1.1, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.15 }}
              >
                <Icon className="w-5 h-5" />
              </motion.div>
            </button>
          )}
        </div>
      ) : (
      <>
      {/* Keypad - wide rounded-rectangle keys that fill their full grid cell
          (no dead space around a small circle), matching the Paytm-style
          reference and the same change made to AmountKeypad. Biometric key
          (when available) fills the grid's empty bottom-left cell instead
          of sitting in a separate button above - tap it to try again after
          the automatic prompt was cancelled or failed. */}
      <div className="grid grid-cols-3 gap-2.5 max-w-[320px] mx-auto">
        {KEYS.map((key, i) => {
          if (key === '') {
            if (!canUseBiometric) return <div key={i} style={{ height: 56 }} />
            return (
              <button
                key={i}
                onClick={tryBiometric}
                disabled={biometricTrying}
                className="w-full flex items-center justify-center mp-key"
                style={{ height: 56, borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--brand-text)' }}
                aria-label={`Use ${label}`}
              >
                <motion.div
                  animate={biometricTrying ? { scale: [1, 1.18, 1], opacity: [1, 0.55, 1] } : { scale: 1, opacity: 1 }}
                  transition={biometricTrying ? { duration: 1.1, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.15 }}
                >
                  <Icon className="w-6 h-6" />
                </motion.div>
              </button>
            )
          }
          if (key === 'del') {
            return (
              <button
                key={i}
                onClick={() => handleKey('del')}
                className="w-full flex items-center justify-center mp-key"
                style={{ height: 56, borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
                aria-label="Delete"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 4H8l-7 8 7 8h13a2 2 0 002-2V6a2 2 0 00-2-2z" />
                  <line x1="18" y1="9" x2="12" y2="15" />
                  <line x1="12" y1="9" x2="18" y2="15" />
                </svg>
              </button>
            )
          }
          return (
            <button
              key={i}
              onClick={() => handleKey(key)}
              className="w-full flex items-center justify-center text-2xl font-semibold text-text-primary mp-key"
              style={{ height: 56, borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--border)' }}
            >
              {key}
            </button>
          )
        })}
      </div>
      </>
      )}
    </div>
  )
}
