import { useState, useRef, useEffect } from 'react'
import { MeshPortLogo } from '@/components/ui/MeshPortLogo'
import { BiometricFirst } from '@/components/ui/BiometricFirst'
import { handBiometricPasscode } from '@/lib/biometricHandoff'
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom'
import { ArrowLeft, Fingerprint, ScanFace, Sun, Sunset, Moon } from 'lucide-react'
import { PinKeypad } from '@/components/ui/PinKeypad'
import { ScreenPush } from '@/components/ui/ScreenPush'
import { ERROR_MOTION } from '@/lib/motion'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuthStore, useUIStore } from '@/store'
import { hashPasscode, verifyPasscode, getPasscodeLockoutRemainingMs, clearPasscodeLockout } from '@/lib/security'
import { hasBiometricRegistered, verifyBiometricAndGetPasscode, biometricLabel, isBiometricSupported, wasBiometricOfferSkippedRecently } from '@/lib/biometric'
import { afterSplash } from '@/lib/splash'
import { greetingTime, greetingText } from '@/lib/greeting'
import { useMediaQuery } from '@/hooks/useMediaQuery'

export function PasscodeSetupPage() {
  const navigate       = useNavigate()
  const [searchParams] = useSearchParams()
  const savePasscode = useAuthStore(s => s.setPasscode)
  const loginType = useAuthStore(s => s.loginType)
  const { showToastMessage } = useUIStore()

  const next      = searchParams.get('next')
  const returning = searchParams.get('returning') === '1'

  // All mutable state lives in refs - no stale closure possible
  const stepRef    = useRef<'create' | 'confirm'>('create')
  const firstRef   = useRef('')
  const secondRef  = useRef('')
  const errorRef   = useRef(false)
  const hashingRef = useRef(false)

  // Display state (drives UI only)
  const [step,     setStep]     = useState<'create' | 'confirm'>('create')
  const [first,    setFirst]    = useState('')  // the passcode chosen (step 1)
  const [second,   setSecond]   = useState('')  // typed again (step 2)
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

  // The shared passcode keypad (PinKeypad) types into the current step; the
  // refs keep the async save below free of stale closures.
  const change = (v: string) => {
    if (hashingRef.current) return
    // A key after a mismatch just clears it (and the confirm dots).
    if (errorRef.current) {
      errorRef.current = false
      setError(false)
      setErrorMsg('')
      secondRef.current = ''
      setSecond('')
      return
    }
    if (stepRef.current === 'create') { firstRef.current = v; setFirst(v) }
    else { secondRef.current = v; setSecond(v) }
  }

  const completeRef = useRef(() => {
    if (stepRef.current === 'create') {
      // Move to confirm
      setTimeout(() => {
        stepRef.current = 'confirm'
        setStep('confirm')
      }, 180)
      return
    }
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
          setSecond('')
        }, 900)
        return
      }
      // Match - save
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
        // local passcode yet (a fresh device, or storage was cleared) -
        // see App.tsx's comment on the returning=1 route.
        //
        // Bug fix: this used to `await restorePrivateKey(...)` BEFORE
        // deciding where to navigate - for a social-auto (Google/Email)
        // account, that's a real server round-trip that can take several
        // seconds, during which the screen just sat there with the
        // confirm dots already filled and nothing else happening. That's
        // exactly what read as the keypad "stuck." Navigate immediately
        // and let the restore happen in the background - same pattern
        // already used in PasscodeLockPage's handleUnlock.
        //
        // No biometric offer here - relogin goes straight into the app.
        // Biometric can still be turned on any time from Settings.
        navigateRef.current('/', { replace: true })
        import('@/lib/restoreWallet').then(({ restorePrivateKey }) => restorePrivateKey(firstRef.current)).catch(() => {})
      } else {
        // New signup (create/import/social) - go straight to the next
        // step (create-wallet / import-wallet / auto-wallet / wallet-
        // setup). No biometric offer during registration either - it
        // stays available afterward from Settings, same as relogin above.
        const next =
          nextRef.current === 'create' ? '/auth/create-wallet'
          : nextRef.current === 'import' ? '/auth/import-wallet'
          : loginTypeRef.current === 'social' ? '/auth/auto-wallet'
          : '/auth/wallet-setup'
        navigateRef.current(next, { replace: true })
      }

    }, 180)
  })

  const handleBack = () => {
    if (stepRef.current === 'confirm') {
      stepRef.current = 'create'
      setStep('create')
      secondRef.current = ''
      setSecond('')
    } else if (returning) {
      navigate('/auth', { replace: true })
    } else {
      navigate(-1)
    }
  }

  const title    = returning
    ? (step === 'create' ? 'Set New Passcode'  : 'Confirm New Passcode')
    : (step === 'create' ? 'Create Passcode'   : 'Confirm Passcode')
  const subtitle = step === 'create'
    ? 'Choose a 6-digit passcode to secure your wallet'
    : 'Enter your passcode again to confirm'

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-bg px-6 py-12 short:py-5">
      <button onClick={handleBack} className="back-btn" style={{marginBottom:14}}>
        <ArrowLeft className="w-5 h-5 text-text-primary" />
      </button>

      <div className="flex gap-1.5 mb-2">
        <div className="flex-1 h-1 rounded-full bg-brand" />
        <div className={`flex-1 h-1 rounded-full transition-colors duration-300 ${step === 'confirm' ? 'bg-brand' : 'bg-text-primary/10'}`} />
      </div>

      {/* Create → Confirm pushes like the other sign-up steps (back slides
          back). The keypad stays one instance; on Confirm it starts empty. */}
      <ScreenPush screenKey={step} back={step === 'create'}>
      <div className="flex-1 flex flex-col items-center">
        <div className="text-center mt-6 short:mt-2 mb-2">
          <div className="w-16 h-16 short:w-12 short:h-12 bg-brand/15 rounded-3xl flex items-center justify-center mx-auto mb-4 short:mb-2">
            <svg className="w-8 h-8 text-brand-text" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
            </svg>
          </div>
          <div>
            <h2 className="text-[20px] tracking-[-0.2px] font-bold text-text-primary">{title}</h2>
            <p className="text-text-secondary mt-1 text-[14px] leading-[1.5]">{subtitle}</p>
          </div>
        </div>

        {/* Fixed-height status line: an error or "Securing…" appearing never
            pushes the keypad down, and the keypad stays mounted (just
            disabled) while the passcode is saved - swapping it out for text
            made the whole screen jump right before moving on. */}
        <div className="h-6 my-3 short:my-2 flex items-center justify-center">
          <AnimatePresence mode="popLayout" initial={false}>
            {errorMsg ? (
              <motion.p key="err" {...ERROR_MOTION}
                className="text-danger text-sm text-center">{errorMsg}</motion.p>
            ) : hashing ? (
              <motion.p key="saving" {...ERROR_MOTION}
                className="text-text-secondary text-sm">Securing passcode…</motion.p>
            ) : null}
          </AnimatePresence>
        </div>

        {/* The app's passcode keypad (typed input on desktop). No fingerprint
            here: this is choosing a passcode, not checking one. */}
        <div className="w-full" style={{ pointerEvents: hashing ? 'none' : undefined, opacity: hashing ? 0.5 : 1, transition: 'opacity 0.15s' }}>
          <PinKeypad value={step === 'create' ? first : second} onChange={change} length={6}
            error={error} shake={error} biometricAvailable={false} autoBiometric={false}
            onComplete={() => completeRef.current()} />
        </div>

        <p className="text-xs text-text-muted text-center mt-8 short:mt-4 px-4">
          Stored securely on this device. Cannot be recovered if lost.
        </p>
      </div>
      </ScreenPush>
    </div>
  )
}

// ─── Lock Screen ──────────────────────────────────────────────────────────────
/** How long the lock screen waits for the wallet to open before going on without it. */
const OPEN_WAIT_MS = 8_000

export function PasscodeLockPage() {
  const short = useMediaQuery('(max-height: 700px)')
  const navigate = useNavigate()
  const location = useLocation()
  // Where to send the user once they unlock - e.g. a shared payment link
  // (/pay/someone?amount=5) that hit AuthGuard's `if (isLocked)` check
  // (App.tsx) and got bounced here first. AuthGuard passes the page they
  // were actually trying to reach as `state.from`; without reading it back
  // here, every locked-wallet deep link - payment links, pay-send with a
  // prefilled recipient, a shared QR - always dumped the user on Home after
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
  const [opening,   setOpening]   = useState(false)

  // Get the wallet ready while this screen is up, so it's open the moment
  // the passcode is accepted - not loaded only then. Google / email wallets
  // (Privy, and the old device-kept ones) need no passcode to open: start
  // now. Created / imported wallets need it: load the wallet frame now, and
  // open it with the passcode in handleUnlock.
  useEffect(() => {
    const { walletAddress: address, signer, walletSource } = useAuthStore.getState()
    if (!address || signer) return
    if (walletSource === 'privy' || walletSource === 'social-auto') {
      import('@/lib/restoreWallet').then(m => m.restorePrivateKey(undefined, { silent: true })).catch(() => {})
    } else if (walletSource !== 'circle') {
      import('@/wallet').then(w => w.walletReady()).catch(() => {})
      import('@/lib/restoreWallet').catch(() => {})
    }
  }, [])

  const displayName = user?.displayName || user?.username?.replace('.arc','') || 'Welcome back'
  const greetName = user?.displayName || user?.username?.replace('.arc','') || ''
  // Set once per visit, so it doesn't change under them while unlocking.
  const [greetAt] = useState(() => greetingTime())
  const GreetIcon = greetAt === 'night' ? Moon : greetAt === 'evening' ? Sunset : Sun
  const noPasscode  = !passcode
  const label = biometricLabel()
  const BiometricIcon = label === 'Face ID' ? ScanFace : Fingerprint

  // Live capability check, not just "was a credential registered once" -
  // EnableBiometricPage (Settings' enable flow) already does this before
  // showing its button; this lock screen never did, so it could show a
  // biometric key that was guaranteed to fail with no visible error
  // (verifyBiometricAndGetPasscode's failure path is intentionally silent -
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
  // The prompt is about to open by itself (below): show "Waiting for…" from
  // the first frame. Showing "Tap to use…" until the prompt opened flipped
  // the text right as the lock screen appeared.
  const [autoPending, setAutoPending] = useState(() => biometricReady && typeof document !== 'undefined' && document.visibilityState === 'visible')
  useEffect(() => { if (liveSupported === false) { setMode('pin'); setAutoPending(false) } }, [liveSupported])

  const handleUnlock = async (val: string, fromBiometric = false) => {
    setChecking(true)
    // Open the wallet alongside the passcode check, not after it - both are
    // deliberately slow (PBKDF2), so this halves the wait. Only for a
    // passcode likely to be right (the first try here, or one Face ID /
    // fingerprint handed back): a wrong one also counts against the wallet
    // frame's own attempt limit, which a later fingerprint unlock doesn't
    // clear.
    const opened = useAuthStore.getState().signer ? Promise.resolve(true)
      : (fromBiometric || attempts === 0)
        ? import('@/lib/restoreWallet').then(m => m.restorePrivateKey(val, { silent: true })).catch(() => false)
        : null
    let correct = false
    if (passcode) {
      // No `val === passcode` fallback here on purpose: verifyPasscode()
      // already has its own last-resort plaintext comparison for legacy
      // stored passcodes, and - unlike this call site - it's gated by the
      // brute-force lockout (see security.ts). A duplicate check here would
      // bypass that lockout entirely for legacy plaintext-format accounts.
      try { correct = await verifyPasscode(val, passcode) } catch {}
    }
    if (correct) {
      // Open the app with the wallet open, like MetaMask / Phantom: Send,
      // Swap and the rest work on the first tap, and the passcode asked
      // there only confirms the payment. The frame was loaded while this
      // screen was up and the decrypt ran beside the passcode check, so
      // this is usually short. Capped: a slow Privy or a stuck frame
      // doesn't hold the lock screen - the open finishes in the background
      // (restorePrivateKey below) and the payment screens wait for it.
      if (!useAuthStore.getState().signer) {
        setOpening(true)
        const open = opened ?? import('@/lib/restoreWallet').then(m => m.restorePrivateKey(val, { silent: true })).catch(() => false)
        await Promise.race([open, new Promise(r => setTimeout(r, OPEN_WAIT_MS))])
        setOpening(false)
      }
      setChecking(false)
      unlock()
      useUIStore.getState().setWalletRecoveryNeeded(false)
      // Offer biometric setup whenever it isn't already enrolled for this
      // wallet and hasn't been declined recently - see
      // wasBiometricOfferSkippedRecently below for the 24h cooldown after
      // Skip (or a cancelled OS prompt), and hasBiometricRegistered (via
      // canUseBiometric) for why this stops for good once actually
      // enabled. That pair already prevents repeat-nagging on its own, so
      // this no longer also gates on signer being null.
      //
      // BUG FIX - it used to also require `!signer`, meant to detect a
      // genuine fresh login (key actually cleared, e.g. by logout()) vs a
      // routine re-lock (offline / browser closed) where the key stays in
      // memory. That worked by accident for import-privkey/social-auto,
      // whose restores need a passcode or a network round trip and so are
      // still in flight when this runs - but for create/import-seed
      // wallets, App.tsx's mount-time restore derives the key from the
      // mnemonic synchronously, no network, and reliably finishes BEFORE
      // the user is even done typing their unlock passcode. `signer`
      // was therefore already populated here on every seed-phrase unlock,
      // permanently and silently skipping the offer for that wallet type
      // only - never for import-privkey or social-auto, which is exactly
      // the asymmetry reported.
      const skippedRecently = walletAddress ? wasBiometricOfferSkippedRecently(walletAddress) : false
      // Only offer it where the device can actually do it - otherwise that
      // page showed blank while it checked, then bounced on.
      if (!canUseBiometric && !skippedRecently && liveSupported === true) {
        handBiometricPasscode(val); navigate('/auth/enable-biometric', { replace: true, state: { next: returnTo } })
      } else {
        navigate(returnTo, { replace: true })
      }
      import('@/lib/restoreWallet').then(({ restorePrivateKey }) => restorePrivateKey(val)).catch(() => {})
        // Then move any older, weaker (100k-iteration) encryption to the
        // current scheme - runs after the restore so unlocking stays instant.
        .then(() => import('@/lib/security'))
        .then(async ({ upgradeLegacyEncryption }) => {
          const newHash = await upgradeLegacyEncryption(walletAddress, val, passcode)
          if (newHash) useAuthStore.getState().setPasscode(newHash)
        }).catch(() => {})
    } else {
      setChecking(false)
      setBiometricTrying(false) // a fingerprint that recovered a stale passcode: back to the keys
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
    setAutoPending(false)
    const pc = await verifyBiometricAndGetPasscode(walletAddress, storedPasscodeHash ?? undefined)
    // Accepted: stay on "Waiting…" until Home is up - switching back to "Tap
    // to use biometrics" for that moment read like the scan had failed.
    if (!pc) setBiometricTrying(false)
    // A cancelled/failed biometric check shows no error - cancelling is an
    // entirely normal choice here, not a mistake. The fingerprint view stays
    // ("Unlock with fingerprint" to try again, or "Use passcode").
    if (pc) {
      // Fixed (/cso follow-up): a real OS-verified Face ID/fingerprint
      // success recovers the true passcode via a device-bound credential -
      // it isn't a guess, so it must not be blocked by the brute-force
      // lockout on the manual-entry path below. Without this, a user
      // locked out from a few mistyped passcodes would find biometric
      // unlock "broken" too, even though they just authenticated for real.
      clearPasscodeLockout()
      handleUnlock(pc, true)
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
    if (!canAuto) { setAutoPending(false); return }
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelSplash = () => {}
    const run = () => {
      if (autoTriedRef.current || inputRef.current.length > 0) { setAutoPending(false); return }
      autoTriedRef.current = true
      tryBiometricRef.current()
    }
    // On app open, wait for the opening splash to go first, so the prompt
    // comes up over the lock screen rather than over the splash.
    const schedule = () => { cancelSplash = afterSplash(() => { timer = setTimeout(run, 0) }) }
    const onVisible = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', onVisible); schedule() } }
    if (document.visibilityState === 'visible') schedule()
    else document.addEventListener('visibilitychange', onVisible)
    return () => { cancelSplash(); if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [canAuto])

  // The shared keypad types here; a key after a wrong passcode just clears it.
  const handleChange = (v: string) => {
    if (error) { setError(false); setInput(''); return }
    if (checking) return
    setInput(v)
  }

  const handleSignOut = () => { logout(); navigate('/auth', { replace: true }) }

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-bg px-6 py-safe">
      {/* my-auto centres it, and lets it scroll from the top (never cut off
          above) if a very short screen still can't fit it all. */}
      <div className="my-auto flex flex-col items-center gap-2 py-4">
        <MeshPortLogo className="w-20 h-20 short:w-16 short:h-16 mx-auto mb-2" splashTarget />
        {/* "Good morning, Sunil" - the name on its own line, large. */}
        <p className="flex items-center gap-1.5 text-[15px] font-semibold text-text-secondary">
          <GreetIcon className="w-4 h-4" style={{ color: greetAt === 'night' ? 'var(--brand-text)' : '#E8A33A' }} />
          {greetText(greetAt, greetName)}
        </p>
        {greetName && <h2 className="-mt-1.5 text-[26px] leading-tight tracking-[-0.5px] font-bold text-text-primary">{greetName}</h2>}
        <p className="text-text-secondary text-[14px] leading-[1.5]">
          {noPasscode ? `Signed in as ${displayName}` : mode === 'bio' ? 'MeshPort is locked' : 'Enter passcode to unlock'}
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
            <BiometricFirst Icon={BiometricIcon} label={label} verb="Unlock" trying={biometricTrying || autoPending} onTry={tryBiometric}
              onUsePasscode={() => { setAutoPending(false); setMode("pin") }} height={short ? 302 : 352} />
            <button onClick={handleSignOut} className="mt-6 text-text-muted text-sm hover:text-text-secondary transition-colors">
              Sign out
            </button>
          </>
          ) : (
          <>
            {/* One fixed-height status line (as on passcode setup): a message
                appearing never moves the keypad, and only one shows at a time. */}
            <div className="h-6 mt-2 mb-3 flex items-center justify-center">
              <AnimatePresence mode="popLayout" initial={false}>
                {error ? (
                  <motion.p key="err" {...ERROR_MOTION}
                    className="text-danger text-sm text-center">
                    {lockoutMs > 0
                      ? `Too many attempts - try again in ${Math.ceil(lockoutMs / 1000)}s`
                      : `Incorrect passcode${attempts > 1 ? ` · ${attempts} attempts` : ''}`}
                  </motion.p>
                ) : opening ? (
                  <motion.p key="open" {...ERROR_MOTION}
                    className="text-text-secondary text-sm text-center">Opening wallet…</motion.p>
                ) : checking ? (
                  <motion.p key="verify" {...ERROR_MOTION}
                    className="text-text-secondary text-sm text-center">Verifying…</motion.p>
                ) : biometricTrying ? (
                  <motion.p key="bio" {...ERROR_MOTION}
                    className="text-text-secondary text-sm text-center">Checking {label}…</motion.p>
                ) : null}
              </AnimatePresence>
            </div>
            {/* The app's passcode keypad (typed input on desktop). The lock
                screen runs its own fingerprint flow (after the splash, clears
                the lockout), so the pad's key calls it (biometricKey). */}
            <div className="w-full">
              <PinKeypad value={input} onChange={handleChange} length={6} error={error} shake={error}
                onComplete={val => { void handleUnlock(val) }}
                biometricKey={{ show: canUseBiometric, onTry: tryBiometric, trying: biometricTrying }} />
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

// "Good morning," above the name; just "Good morning" when there's no name.
function greetText(t: ReturnType<typeof greetingTime>, name: string) {
  return name ? `${greetingText(t)},` : greetingText(t)
}
