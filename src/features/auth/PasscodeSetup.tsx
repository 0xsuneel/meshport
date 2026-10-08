import { useState, useRef, useEffect, type ComponentType } from 'react'
import { MeshPortLogo } from '@/components/ui/MeshPortLogo'
import { BiometricFirst } from '@/components/ui/BiometricFirst'
import { handBiometricPasscode } from '@/lib/biometricHandoff'
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom'
import { ArrowLeft, Fingerprint, ScanFace } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuthStore, useUIStore } from '@/store'
import { hashPasscode, verifyPasscode, getPasscodeLockoutRemainingMs, clearPasscodeLockout } from '@/lib/security'
import { hasBiometricRegistered, verifyBiometricAndGetPasscode, biometricLabel, isBiometricSupported, wasBiometricOfferSkippedRecently } from '@/lib/biometric'

function PasscodeDots({ filled, error }: { filled: number; error: boolean }) {
  return (
    <div className="flex items-center justify-center gap-4 my-8">
      {Array.from({ length: 6 }).map((_, i) => (
        <motion.div key={i}
          animate={error ? { x: [0,-8,8,-6,6,0] } : { scale: filled > i ? 1.1 : 1 }}
          transition={{ duration: error ? 0.4 : 0.1 }}
          className={`w-4 h-4 rounded-full border-2 transition-colors ${
            error ? 'border-danger bg-danger'
            : filled > i ? 'border-brand bg-brand'
            : 'border-text-secondary/40'
          }`}
        />
      ))}
    </div>
  )
}

function NumPad({ onPress, onBiometric, showBiometric, biometricTrying, BiometricIcon }: {
  onPress: (k: string) => void
  onBiometric?: () => void
  showBiometric?: boolean
  biometricTrying?: boolean
  BiometricIcon?: ComponentType<{ className?: string }>
}) {
  return (
    <div className="grid grid-cols-3 gap-2.5 w-full max-w-xs mx-auto">
      {['1','2','3','4','5','6','7','8','9','biometric','0','⌫'].map((k, i) => {
        if (k === 'biometric') {
          if (!showBiometric || !BiometricIcon) return <div key={i} style={{ height: 56 }} />
          return (
            // Plain button, not motion.button — same reasoning as
            // PinKeypad's biometric key: WebKit is notably stricter than
            // Chromium about a WebAuthn call happening inside a genuine,
            // immediate user gesture, so the OS prompt trigger itself is
            // kept as close to a raw native click as possible rather than
            // going through Framer Motion's gesture-recognition wrapper.
            <button key={i} onClick={onBiometric} disabled={biometricTrying}
              className="flex items-center justify-center text-brand-text mp-key"
              style={{ height: 56, borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--border)' }}
              aria-label="Use biometric unlock">
              <motion.div
                animate={biometricTrying ? { scale: [1, 1.18, 1], opacity: [1, 0.55, 1] } : { scale: 1, opacity: 1 }}
                transition={biometricTrying ? { duration: 1.1, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.15 }}
              >
                <BiometricIcon className="w-6 h-6" />
              </motion.div>
            </button>
          )
        }
        return (
          <button key={i} onClick={() => onPress(k)}
            className={`mp-key flex items-center justify-center text-2xl font-semibold ${
              k === '⌫' ? 'text-text-secondary' : 'text-text-primary'
            }`}
            style={{ height: 56, borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--border)' }}>
            {k === '⌫'
              ? <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M3 12l6.414 6.414a2 2 0 001.414.586H19a2 2 0 002-2V7a2 2 0 00-2-2h-8.172a2 2 0 00-1.414.586L3 12z"/>
                </svg>
              : k}
          </button>
        )
      })}
    </div>
  )
}

export function PasscodeSetupPage() {
  const navigate       = useNavigate()
  const [searchParams] = useSearchParams()
  const savePasscode = useAuthStore(s => s.setPasscode)
  const loginType = useAuthStore(s => s.loginType)
  const { showToastMessage } = useUIStore()

  const next      = searchParams.get('next')
  const returning = searchParams.get('returning') === '1'

  // All mutable state lives in refs — no stale closure possible
  const stepRef    = useRef<'create' | 'confirm'>('create')
  const firstRef   = useRef('')
  const secondRef  = useRef('')
  const errorRef   = useRef(false)
  const hashingRef = useRef(false)

  // Display state (drives UI only)
  const [step,     setStep]     = useState<'create' | 'confirm'>('create')
  const [filled1,  setFilled1]  = useState(0)   // dots for step 1
  const [filled2,  setFilled2]  = useState(0)   // dots for step 2
  const [error,    setError]    = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [hashing,  setHashing]  = useState(false)

  const navigateRef    = useRef(navigate)
  const savePcRef      = useRef(savePasscode)
  const showToastRef   = useRef(showToastMessage)
  const nextRef        = useRef(next)
  const returningRef   = useRef(returning)
  const loginTypeRef   = useRef(loginType)
  navigateRef.current  = navigate
  savePcRef.current    = savePasscode
  showToastRef.current = showToastMessage
  nextRef.current      = next
  returningRef.current = returning
  loginTypeRef.current = loginType

  // Single stable press handler — reads from refs only
  const pressRef = useRef(async (key: string) => {
    // Clear error
    if (errorRef.current) {
      errorRef.current = false
      setError(false)
      setErrorMsg('')
      if (stepRef.current === 'confirm') {
        secondRef.current = ''
        setFilled2(0)
      }
      return
    }

    if (stepRef.current === 'create') {
      if (key === '⌫') {
        firstRef.current = firstRef.current.slice(0, -1)
        setFilled1(firstRef.current.length)
        return
      }
      if (firstRef.current.length >= 6) return
      firstRef.current += key
      setFilled1(firstRef.current.length)
      if (firstRef.current.length < 6) return

      // Move to confirm
      setTimeout(() => {
        stepRef.current = 'confirm'
        setStep('confirm')
      }, 180)

    } else {
      // Confirm step
      if (key === '⌫') {
        secondRef.current = secondRef.current.slice(0, -1)
        setFilled2(secondRef.current.length)
        return
      }
      if (secondRef.current.length >= 6) return
      secondRef.current += key
      setFilled2(secondRef.current.length)
      if (secondRef.current.length < 6) return

      // Verify match
      setTimeout(async () => {
        if (secondRef.current !== firstRef.current) {
          errorRef.current = true
          setError(true)
          setErrorMsg("Passcodes don't match. Try again.")
          setTimeout(() => {
            errorRef.current = false
            setError(false)
            setErrorMsg('')
            secondRef.current = ''
            setFilled2(0)
          }, 900)
          return
        }

        // Match — save
        hashingRef.current = true
        setHashing(true)
        const hashed = await hashPasscode(firstRef.current)
        savePcRef.current(hashed)
        const { stashRawPasscode } = await import('@/lib/restoreWallet')
        stashRawPasscode(firstRef.current)
        hashingRef.current = false
        setHashing(false)
        showToastRef.current(returningRef.current ? 'Welcome back!' : 'Passcode set!', 'success')

        if (returningRef.current) {
          try { sessionStorage.removeItem('mp_returning_signin') } catch { /* none */ }
          // This flow fires when the account exists but THIS browser has no
          // local passcode yet (a fresh device, or storage was cleared) —
          // see App.tsx's comment on the returning=1 route.
          //
          // Bug fix: this used to `await restorePrivateKey(...)` BEFORE
          // deciding where to navigate — for a social-auto (Google/Email)
          // account, that's a real server round-trip that can take several
          // seconds, during which the screen just sat there with the
          // confirm dots already filled and nothing else happening. That's
          // exactly what read as the keypad "stuck." Navigate immediately
          // and let the restore happen in the background — same pattern
          // already used in PasscodeLockPage's handleUnlock.
          //
          // No biometric offer here — relogin goes straight into the app.
          // Biometric can still be turned on any time from Settings.
          // Google / email accounts: the wallet opens only with the
          // passkey or Recovery QR on a new sign-in — go straight there.
          const st = useAuthStore.getState()
          if (st.loginType === 'social' && st.walletSource === 'social-auto' && !st.privateKey) {
            navigateRef.current('/auth/recover-wallet', { replace: true })
            return
          }
          navigateRef.current('/', { replace: true })
          import('@/lib/restoreWallet').then(({ restorePrivateKey }) => restorePrivateKey(firstRef.current)).catch(() => {})
        } else {
          // New signup (create/import/social) — go straight to the next
          // step (create-wallet / import-wallet / auto-wallet / wallet-
          // setup). No biometric offer during registration either — it
          // stays available afterward from Settings, same as relogin above.
          const next =
            nextRef.current === 'create' ? '/auth/create-wallet'
            : nextRef.current === 'import' ? '/auth/import-wallet'
            : loginTypeRef.current === 'social' ? '/auth/auto-wallet'
            : '/auth/wallet-setup'
          navigateRef.current(next, { replace: true })
        }

      }, 180)
    }
  })

  const handleBack = () => {
    if (stepRef.current === 'confirm') {
      stepRef.current = 'create'
      setStep('create')
      secondRef.current = ''
      setFilled2(0)
    } else if (returning) {
      navigate('/auth', { replace: true })
    } else {
      navigate(-1)
    }
  }

  const filledCount = step === 'create' ? filled1 : filled2
  const title    = returning
    ? (step === 'create' ? 'Set New Passcode'  : 'Confirm New Passcode')
    : (step === 'create' ? 'Create Passcode'   : 'Confirm Passcode')
  const subtitle = step === 'create'
    ? 'Choose a 6-digit passcode to secure your wallet'
    : 'Enter your passcode again to confirm'

  return (
    <div className="flex flex-col h-full bg-bg px-6 py-12">
      <button onClick={handleBack} className="back-btn" style={{marginBottom:24}}>
        <ArrowLeft className="w-5 h-5 text-text-primary" />
      </button>

      <div className="flex gap-1.5 mb-2">
        <div className="flex-1 h-1 rounded-full bg-brand" />
        <div className={`flex-1 h-1 rounded-full transition-colors duration-300 ${step === 'confirm' ? 'bg-brand' : 'bg-text-primary/10'}`} />
      </div>

      <div className="flex-1 flex flex-col items-center">
        <div className="text-center mt-6 mb-2">
          <div className="w-16 h-16 bg-brand/15 rounded-3xl flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-brand-text" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
            </svg>
          </div>
          {/* The title just changes — any fade between "Set" and "Confirm"
              reads as a flicker on a phone. */}
          <div>
            <h2 className="text-[20px] tracking-[-0.2px] font-bold text-text-primary">{title}</h2>
            <p className="text-text-secondary mt-1 text-[14px] leading-[1.5]">{subtitle}</p>
          </div>
        </div>

        {/* Keyed by step: the dots start empty on Confirm instead of fading
            out from the six filled ones. */}
        <PasscodeDots key={step} filled={filledCount} error={error} />

        {/* Fixed-height status line: an error or "Securing…" appearing never
            pushes the keypad down, and the keypad stays mounted (just
            disabled) while the passcode is saved — swapping it out for text
            made the whole screen jump right before moving on. */}
        <div className="h-6 mb-2 flex items-center justify-center">
          <AnimatePresence mode="popLayout" initial={false}>
            {errorMsg ? (
              <motion.p key="err" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="text-danger text-sm text-center">{errorMsg}</motion.p>
            ) : hashing ? (
              <motion.p key="saving" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="text-text-secondary text-sm">Securing passcode…</motion.p>
            ) : null}
          </AnimatePresence>
        </div>

        <div className="w-full" style={{ pointerEvents: hashing ? 'none' : undefined, opacity: hashing ? 0.5 : 1, transition: 'opacity 0.15s' }}>
          <NumPad onPress={(k) => pressRef.current(k)} />
        </div>

        <p className="text-xs text-text-muted text-center mt-8 px-4">
          Stored securely on this device. Cannot be recovered if lost.
        </p>
      </div>
    </div>
  )
}

// ─── Lock Screen ──────────────────────────────────────────────────────────────
export function PasscodeLockPage() {
  const navigate = useNavigate()
  const location = useLocation()
  // Where to send the user once they unlock — e.g. a shared payment link
  // (/pay/someone?amount=5) that hit AuthGuard's `if (isLocked)` check
  // (App.tsx) and got bounced here first. AuthGuard passes the page they
  // were actually trying to reach as `state.from`; without reading it back
  // here, every locked-wallet deep link — payment links, pay-send with a
  // prefilled recipient, a shared QR — always dumped the user on Home after
  // unlocking, silently discarding wherever they were headed. Falls back to
  // '/' for the ordinary case (opening the app itself while locked, or any
  // other route that didn't arrive with a `from`).
  const fromLocation = (location.state as { from?: { pathname: string; search: string } } | null)?.from
  const returnTo = fromLocation ? `${fromLocation.pathname}${fromLocation.search || ''}` : '/'
  const passcode = useAuthStore(s => s.passcode)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const biometricEnabled = useAuthStore(s => s.biometricEnabled)
  const unlock = useAuthStore(s => s.unlock)
  const logout = useAuthStore(s => s.logout)
  const user = useAuthStore(s => s.user)
  const [input,     setInput]     = useState('')
  const [error,     setError]     = useState(false)
  const [attempts,  setAttempts]  = useState(0)
  const [lockoutMs, setLockoutMs] = useState(0)
  const [checking,  setChecking]  = useState(false)
  const [biometricTrying, setBiometricTrying] = useState(false)

  const displayName = user?.displayName || user?.username?.replace('.arc','') || 'Welcome back'
  const noPasscode  = !passcode
  const label = biometricLabel()
  const BiometricIcon = label === 'Face ID' ? ScanFace : Fingerprint

  // Live capability check, not just "was a credential registered once" —
  // EnableBiometricPage (Settings' enable flow) already does this before
  // showing its button; this lock screen never did, so it could show a
  // biometric key that was guaranteed to fail with no visible error
  // (verifyBiometricAndGetPasscode's failure path is intentionally silent —
  // see its own comment) on a device/context where the platform check isn't
  // actually usable right now, e.g. iOS Safari's installed/home-screen PWA
  // context vs. a regular Safari tab, or a desktop machine with no Windows
  // Hello/Touch ID configured.
  // null until the probe answers (the key shows meanwhile); the automatic
  // prompt waits for a real yes.
  const [liveSupported, setLiveSupported] = useState<boolean | null>(null)
  useEffect(() => { isBiometricSupported().then(setLiveSupported) }, [])

  const biometricReady = biometricEnabled && !!walletAddress && hasBiometricRegistered(walletAddress)
  const canUseBiometric = biometricReady && liveSupported !== false
  // Biometric on → fingerprint / Face ID first; the number pad appears once
  // the scan fails or is cancelled, or on "Use passcode".
  const [mode, setMode] = useState<'bio' | 'pin'>(() => (biometricReady ? 'bio' : 'pin'))
  useEffect(() => { if (liveSupported === false) setMode('pin') }, [liveSupported])

  const handleUnlock = async (val: string) => {
    setChecking(true)
    let correct = false
    if (passcode) {
      // No `val === passcode` fallback here on purpose: verifyPasscode()
      // already has its own last-resort plaintext comparison for legacy
      // stored passcodes, and — unlike this call site — it's gated by the
      // brute-force lockout (see security.ts). A duplicate check here would
      // bypass that lockout entirely for legacy plaintext-format accounts.
      try { correct = await verifyPasscode(val, passcode) } catch {}
    }
    if (correct) {
      // Unlock and navigate the instant the passcode is confirmed — don't
      // make the user sit on this screen waiting for the wallet key to
      // fully restore first. That restore can be a genuine network round
      // trip (social-auto accounts fetch it from the server), which turned
      // "enter passcode" into a multi-second "Restoring wallet…" wait
      // instead of an instant unlock. Kicked off here in the background
      // instead: the rest of the app already copes with the key not being
      // immediately available (see getKey() in the Multichain pages, and
      // the wallet-recovery banner, which now self-clears — see setWallet
      // in store/index.ts — the moment this actually resolves).
      setChecking(false)
      unlock()
      useUIStore.getState().setWalletRecoveryNeeded(false)
      // Offer biometric setup whenever it isn't already enrolled for this
      // wallet and hasn't been declined recently — see
      // wasBiometricOfferSkippedRecently below for the 24h cooldown after
      // Skip (or a cancelled OS prompt), and hasBiometricRegistered (via
      // canUseBiometric) for why this stops for good once actually
      // enabled. That pair already prevents repeat-nagging on its own, so
      // this no longer also gates on privateKey being null.
      //
      // BUG FIX — it used to also require `!privateKey`, meant to detect a
      // genuine fresh login (key actually cleared, e.g. by logout()) vs a
      // routine re-lock (offline / browser closed) where the key stays in
      // memory. That worked by accident for import-privkey/social-auto,
      // whose restores need a passcode or a network round trip and so are
      // still in flight when this runs — but for create/import-seed
      // wallets, App.tsx's mount-time restore derives the key from the
      // mnemonic synchronously, no network, and reliably finishes BEFORE
      // the user is even done typing their unlock passcode. `privateKey`
      // was therefore already populated here on every seed-phrase unlock,
      // permanently and silently skipping the offer for that wallet type
      // only — never for import-privkey or social-auto, which is exactly
      // the asymmetry reported.
      const skippedRecently = walletAddress ? wasBiometricOfferSkippedRecently(walletAddress) : false
      // Only offer it where the device can actually do it — otherwise that
      // page showed blank while it checked, then bounced on.
      if (!canUseBiometric && !skippedRecently && liveSupported === true) {
        handBiometricPasscode(val); navigate('/auth/enable-biometric', { replace: true, state: { next: returnTo } })
      } else {
        navigate(returnTo, { replace: true })
      }
      import('@/lib/restoreWallet').then(({ restorePrivateKey }) => restorePrivateKey(val)).catch(() => {})
        // Then move any older, weaker (100k-iteration) encryption to the
        // current scheme — runs after the restore so unlocking stays instant.
        .then(() => import('@/lib/security'))
        .then(async ({ upgradeLegacyEncryption }) => {
          const newHash = await upgradeLegacyEncryption(walletAddress, val, passcode)
          if (newHash) useAuthStore.getState().setPasscode(newHash)
        }).catch(() => {})
    } else {
      setChecking(false)
      setAttempts(a => a + 1)
      setLockoutMs(getPasscodeLockoutRemainingMs())
      setError(true); setInput('')
      setTimeout(() => setError(false), 800)
    }
  }

  const storedPasscodeHash = passcode
  // Lock screen is up → show the app again (see 'mp-locking' in App.tsx).
  useEffect(() => { document.documentElement.classList.remove('mp-locking') }, [])
  const tryBiometric = async () => {
    if (!walletAddress || biometricTrying) return
    setBiometricTrying(true)
    const pc = await verifyBiometricAndGetPasscode(walletAddress, storedPasscodeHash ?? undefined)
    setBiometricTrying(false)
    // A cancelled/failed biometric check just falls back to the normal
    // passcode entry already on screen — no error shown, since cancelling
    // is an entirely normal choice here, not a mistake.
    if (pc) {
      // Fixed (/cso follow-up): a real OS-verified Face ID/fingerprint
      // success recovers the true passcode via a device-bound credential —
      // it isn't a guess, so it must not be blocked by the brute-force
      // lockout on the manual-entry path below. Without this, a user
      // locked out from a few mistyped passcodes would find biometric
      // unlock "broken" too, even though they just authenticated for real.
      clearPasscodeLockout()
      handleUnlock(pc)
    } else {
      setMode('pin')
    }
  }

  // Biometric enabled → the fingerprint / Face ID prompt opens by itself
  // when the lock screen appears (same as PinKeypad for transaction
  // approvals). Cancelled, failed, or refused by the browser (iOS Safari
  // may refuse a prompt nobody tapped for) → the passcode pad is already
  // here, and the fingerprint key stays to try again. Once per visit, never
  // after typing has started, and only while the page is visible.
  const autoTriedRef = useRef(false)
  const inputRef = useRef(input)
  inputRef.current = input
  const tryBiometricRef = useRef(tryBiometric)
  tryBiometricRef.current = tryBiometric
  // Don't wait for the capability probe: the prompt opens at once, and if
  // the device can't do it the call just fails into the passcode pad.
  const canAuto = biometricReady && liveSupported !== false
  useEffect(() => {
    if (!canAuto) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = () => {
      if (autoTriedRef.current || inputRef.current.length > 0) return
      autoTriedRef.current = true
      tryBiometricRef.current()
    }
    const schedule = () => { timer = setTimeout(run, 0) }
    const onVisible = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', onVisible); schedule() } }
    if (document.visibilityState === 'visible') schedule()
    else document.addEventListener('visibilitychange', onVisible)
    return () => { if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [canAuto])

  const handlePress = async (key: string) => {
    if (error) { setError(false); setInput(''); return }
    if (key === '⌫') { setInput(c => c.slice(0, -1)); return }
    if (input.length >= 6 || checking) return
    const val = input + key
    setInput(val)
    if (val.length < 6) return
    setTimeout(() => handleUnlock(val), 180)
  }

  const handleSignOut = () => { logout(); navigate('/auth', { replace: true }) }

  return (
    <div className="flex flex-col h-full bg-bg px-6 py-safe">
      <div className="flex-1 flex flex-col items-center justify-center gap-2">
        <MeshPortLogo className="w-20 h-20 mx-auto mb-2" />
        <h2 className="text-[20px] tracking-[-0.2px] font-bold text-text-primary">MeshPort</h2>
        <p className="text-text-secondary text-[14px] leading-[1.5]">
          {noPasscode ? `Signed in as ${displayName}` : mode === 'bio' ? `Unlock with ${label === 'Fingerprint' ? 'your fingerprint' : label === 'Face ID' ? 'Face ID' : 'biometrics'}` : 'Enter passcode to unlock'}
        </p>
        {noPasscode ? (
          <div className="mt-8 w-full max-w-xs space-y-3">
            <button onClick={async () => { unlock(); navigate(returnTo, { replace: true }) }}
              className="w-full py-4 bg-brand rounded-2xl text-white font-bold shadow-elevation-2 active:scale-[.98] transition-transform border border-black/10">
              Continue as {displayName}
            </button>
            <button onClick={handleSignOut}
              className="w-full py-4 bg-surface border border-border rounded-2xl text-text-secondary font-semibold active:scale-[.98] transition-transform">
              Sign Out
            </button>
          </div>
        ) : (
          mode === 'bio' ? (
          <>
            {/* Same space as dots + status line + number pad, so "Use
                passcode" swaps in place without the logo moving. */}
            <BiometricFirst Icon={BiometricIcon} label={label} trying={biometricTrying} onTry={tryBiometric}
              onUsePasscode={() => setMode("pin")} height={374} />
            <button onClick={handleSignOut} className="mt-6 text-text-muted text-sm hover:text-text-secondary transition-colors">
              Sign out
            </button>
          </>
          ) : (
          <>
            <PasscodeDots filled={input.length} error={error} />
            {/* One fixed-height status line (as on passcode setup): a message
                appearing never moves the dots and keypad, and only one shows
                at a time. */}
            <div className="h-6 -mt-2 flex items-center justify-center">
              <AnimatePresence mode="popLayout" initial={false}>
                {error ? (
                  <motion.p key="err" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="text-danger text-sm text-center">
                    {lockoutMs > 0
                      ? `Too many attempts — try again in ${Math.ceil(lockoutMs / 1000)}s`
                      : `Incorrect passcode${attempts > 1 ? ` · ${attempts} attempts` : ''}`}
                  </motion.p>
                ) : checking ? (
                  <motion.p key="verify" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="text-text-secondary text-sm text-center">Verifying…</motion.p>
                ) : biometricTrying ? (
                  <motion.p key="bio" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="text-text-secondary text-sm text-center">Checking {label}…</motion.p>
                ) : null}
              </AnimatePresence>
            </div>
            <div className="w-full mt-2">
              <NumPad onPress={handlePress} onBiometric={tryBiometric} showBiometric={canUseBiometric} biometricTrying={biometricTrying} BiometricIcon={BiometricIcon} />
            </div>
            <button onClick={handleSignOut} className="mt-6 text-text-muted text-sm hover:text-text-secondary transition-colors">
              Sign out
            </button>
          </>
          )
        )}
      </div>
    </div>
  )
}
