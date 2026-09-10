import { AlertTriangle, X, ArrowRight, RotateCw, Loader2, Lock } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useState, useEffect, useRef } from 'react'
import { useAuthStore, useUIStore } from '@/store'
import { Sheet } from '@/components/ui/Sheet'
import { PinKeypad } from '@/components/ui/PinKeypad'

/**
 * Shown whenever restoreWallet.ts has exhausted every automatic recovery
 * path for the current wallet (no local key, no server-side backup
 * reachable) — see restorePrivateKey()'s own doc comment for the full
 * priority order it tries before giving up.
 *
 * Two distinct states, not one — this is the actual fix for a real
 * complaint: the banner used to show the same alarming, final-sounding
 * "Couldn't restore... on this device" the INSTANT the first attempt
 * failed, even though AppLayout.tsx runs a quiet background retry every
 * 20s the whole time this is up. A user has no way to know that silent
 * retry is happening — from their side, a banner that says "couldn't"
 * (past tense, sounds done) paired with an app that's actually still
 * working on it reads exactly like a bug, not an in-progress recovery.
 *
 *   - First ~90s: a calm, neutral "Still restoring your wallet…" state.
 *     No warning color, no icon implying something's wrong — this is the
 *     normal, expected shape of a real server round-trip (social-auto
 *     accounts fetch their key from the server; this isn't instant even
 *     when everything is working correctly).
 *   - Past ~90s with still no success: escalates to the current amber
 *     warning styling, "Try again", and the recovery-phrase fallback —
 *     genuinely worth the user's attention at this point, not before.
 *
 * For social-auto accounts (Google/Email), reaching the escalated state
 * means the server-side backup itself is missing or the session is
 * invalid — "Try again" is the main lever, since there's no recovery
 * phrase to fall back to for these accounts. For create/import accounts,
 * this is where a user genuinely needs to re-enter their saved recovery
 * phrase manually.
 *
 * Deliberately a persistent banner, not a one-off toast: a toast disappears
 * in 3.5s (see useUIStore.showToastMessage) and the user had no path
 * forward — that was the actual gap this closes. Stays until either a
 * restore attempt succeeds (walletRecoveryNeeded flips back to false,
 * cleared centrally in restoreWallet.ts) or the user dismisses it for THIS
 * session (dismissal is local component state, not persisted — reappears
 * on the next failed restore attempt rather than being silenced forever).
 */
const ESCALATE_AFTER_MS = 90_000

export function WalletRecoveryBanner() {
  const navigate = useNavigate()
  const needed = useUIStore(s => s.walletRecoveryNeeded)
  const walletSource = useAuthStore(s => s.walletSource)
  const [dismissed, setDismissed] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const neededSinceRef = useRef<number | null>(null)
  const [, forceTick] = useState(0)
  const [showPasscodePrompt, setShowPasscodePrompt] = useState(false)
  const [pin, setPin] = useState('')
  const [pinError, setPinError] = useState(false)
  const [unlocking, setUnlocking] = useState(false)

  useEffect(() => {
    if (needed) {
      if (neededSinceRef.current === null) neededSinceRef.current = Date.now()
    } else {
      neededSinceRef.current = null
      setDismissed(false) // a fresh future failure should show the calm state again, not stay dismissed forever
    }
  }, [needed])

  // Forces a re-render purely so the calm→escalated transition actually
  // happens on its own after enough time passes, rather than only ever
  // re-checking on some unrelated state change.
  useEffect(() => {
    if (!needed) return
    const interval = setInterval(() => forceTick(t => t + 1), 5000)
    return () => clearInterval(interval)
  }, [needed])

  if (!needed || dismissed) return null

  const elapsedMs = neededSinceRef.current ? Date.now() - neededSinceRef.current : 0
  const escalated = elapsedMs >= ESCALATE_AFTER_MS

  const handleRetry = async () => {
    setRetrying(true)
    try {
      const { restorePrivateKey } = await import('@/lib/restoreWallet')
      await restorePrivateKey()
      // No need to check the result here — restorePrivateKey() itself
      // updates walletRecoveryNeeded on the store, which is what controls
      // whether this banner even renders (see the `needed` check above).
    } finally {
      setRetrying(false)
    }
  }

  // BUG FIX (2026-09-03) — an import-privkey wallet has no recovery phrase
  // at all (that's the whole point of importing by private key instead of
  // seed words), so offering "Restore with your saved recovery phrase" —
  // which routed to a screen asking for exactly the thing this account
  // never had — was a dead end disguised as a fix. What actually unlocks
  // it is the same thing that always does: the user's app passcode,
  // decrypting the key that's already sitting on this device (see
  // restoreWallet.ts step 3). This prompts for it inline instead of
  // sending the user somewhere that can't possibly help.
  const handlePasscodeSubmit = async (enteredPin: string) => {
    setUnlocking(true)
    setPinError(false)
    try {
      const { restorePrivateKey } = await import('@/lib/restoreWallet')
      const ok = await restorePrivateKey(enteredPin)
      if (ok) {
        setShowPasscodePrompt(false)
        setPin('')
      } else {
        setPinError(true)
        setPin('')
      }
    } finally {
      setUnlocking(false)
    }
  }

  if (!escalated) {
    return (
      <div
        style={{
          position: 'absolute',
          top: 0, left: 0, right: 0,
          zIndex: 60,
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border)',
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <Loader2 className="w-4 h-4 text-brand flex-shrink-0 animate-spin" />
        <p style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-secondary)', margin: 0, flex: 1 }}>
          Still restoring your wallet…
        </p>
      </div>
    )
  }

  return (
    <>
    <div
      style={{
        position: 'absolute',
        top: 0, left: 0, right: 0,
        zIndex: 60,
        background: 'color-mix(in srgb, var(--warning) 16%, var(--surface))',
        borderBottom: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)',
        padding: '10px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
          Couldn't restore your wallet automatically on this device
        </p>
        <div style={{ display: 'flex', gap: 14, marginTop: 2, flexWrap: 'wrap' }}>
          <button
            onClick={handleRetry}
            disabled={retrying}
            style={{
              fontSize: 12, color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: 3,
              background: 'none', border: 'none', padding: 0, cursor: retrying ? 'default' : 'pointer',
              opacity: retrying ? 0.6 : 1,
            }}
          >
            <RotateCw className={`w-3 h-3 ${retrying ? 'animate-spin' : ''}`} />
            {retrying ? 'Retrying…' : 'Try again'}
          </button>
          {/* BUG FIX (2026-09-03) — this second option used to be
              unconditional, but only create/import-seed wallets actually
              HAVE a recovery phrase to fall back to:
                - import-privkey: no recovery phrase ever existed. The real
                  unlock is the device's own encrypted key + passcode —
                  prompt for that instead of sending the user to a screen
                  asking for something they don't have.
                - social-auto (Google/Email): no local secret of any kind
                  by design — the server-side vault + "Try again" is the
                  only lever there really is; a recovery-phrase link here
                  was always a dead end for these accounts too. */}
          {(walletSource === 'create' || walletSource === 'import-seed') && (
            <button
              onClick={() => { setDismissed(true); navigate('/auth/import-wallet') }}
              style={{
                fontSize: 12, color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: 3,
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              }}
            >
              Restore with your saved recovery phrase <ArrowRight className="w-3 h-3" />
            </button>
          )}
          {walletSource === 'import-privkey' && (
            <button
              onClick={() => setShowPasscodePrompt(true)}
              style={{
                fontSize: 12, color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: 3,
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              }}
            >
              <Lock className="w-3 h-3" /> Enter your passcode to unlock
            </button>
          )}
        </div>
      </div>
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        style={{ background: 'none', border: 'none', padding: 4, cursor: 'pointer', flexShrink: 0 }}
      >
        <X className="w-4 h-4 text-warning" />
      </button>
    </div>

    {showPasscodePrompt && (
      <Sheet isOpen={showPasscodePrompt} onClose={() => { setShowPasscodePrompt(false); setPin(''); setPinError(false) }} title="Enter your passcode">
        <div style={{ padding: '8px 20px 24px', textAlign: 'center' }}>
          <Lock className="w-8 h-8 text-brand mx-auto mb-3" />
          <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '0 0 20px' }}>
            Unlocks your wallet's encrypted key, stored on this device.
          </p>
          <PinKeypad
            value={pin}
            onChange={val => { setPin(val); setPinError(false) }}
            onComplete={handlePasscodeSubmit}
            error={pinError}
          />
          {unlocking && (
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 12 }}>Unlocking…</p>
          )}
          {pinError && !unlocking && (
            <p style={{ fontSize: 12, color: 'var(--danger)', marginTop: 12 }}>Incorrect passcode — try again.</p>
          )}
        </div>
      </Sheet>
    )}
    </>
  )
}
