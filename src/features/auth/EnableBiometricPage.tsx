import { CONTROL_MOTION } from '@/lib/motion'
import { useEffect, useState, useRef } from 'react'
import { takeBiometricPasscode, takeBiometricPending, clearBiometricPasscode } from '@/lib/biometricHandoff'
import { useNavigate, useLocation } from 'react-router-dom'
import { Fingerprint, ScanFace } from 'lucide-react'
import { motion } from 'framer-motion'
import { useAuthStore, useUIStore } from '@/store'
import {
  isBiometricSupported, registerBiometric, confirmBiometricRegistration, abandonBiometricRegistration, removeBiometric,
  biometricLabel, biometricFailureMessage, recordBiometricOfferSkip, isApplePasskeyDevice,
  type BiometricRegisterResult, type PendingBiometricRegistration,
} from '@/lib/biometric'

/**
 * Shown right after a passcode is confirmed - for new signups (create/
 * import/social), for a returning login on a browser with no local
 * biometric registered yet (see PasscodeSetup.tsx's returning=1 flow and
 * PasscodeLockPage's unlock handler), and reused again from Settings'
 * "Confirm Passcode" sheet when the user turns the toggle on manually.
 * One single place that actually asks "enable biometric?", rather than
 * each entry point building its own version of this and drifting apart.
 * Always skippable - Skip is exactly as prominent as Enable.
 *
 * Navigated to with the caller's own return destination passed through
 * router state (`next`), so this slots into whatever flow triggered it
 * without needing to know what that flow was.
 */
export function EnableBiometricPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const user = useAuthStore(s => s.user)
  const { showToastMessage } = useUIStore()
  const [supported, setSupported] = useState<boolean | null>(null)
  const [working, setWorking] = useState(false)

  const nextPath: string = (location.state as any)?.next ?? '/'
  // Read once on mount (memory only - see biometricHandoff.ts).
  const [rawPasscode] = useState(() => takeBiometricPasscode())
  useEffect(() => () => clearBiometricPasscode(), [])
  const label = biometricLabel()
  const Icon = label === 'Face ID' ? ScanFace : Fingerprint
  // iPhone / iPad / Mac show Apple's "Save a passkey" sheet first (see biometric.ts).
  const apple = isApplePasskeyDevice()

  useEffect(() => {
    isBiometricSupported().then(setSupported)
  }, [])

  // Device genuinely doesn't support it - skip straight through rather
  // than showing a screen for a capability that isn't there. Checked async
  // on mount, so this only fires after we actually know one way or the
  // other, not optimistically.
  useEffect(() => {
    if (supported === false) navigate(nextPath, { replace: true })
  }, [supported, nextPath, navigate])

  const settledRef = useRef(false)
  // Credential created (or a passcode change to re-seal), verification test
  // still owed (Safari allows one prompt per tap) - see registerBiometric /
  // updateBiometricPasscode. Memory only.
  const [pending, setPending] = useState<PendingBiometricRegistration | null>(() => takeBiometricPending())
  const reseal = !!pending?.reseal
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  // Leaving without confirming forgets the half-made credential.
  useEffect(() => () => { if (pendingRef.current) abandonBiometricRegistration(pendingRef.current) }, [])

  const settle = (result: BiometricRegisterResult) => {
    // If the user already tapped Skip while this was still in flight (the
    // call can hang for the full WebAuthn timeout), don't act on a result
    // that arrives after they've moved on - and don't leave behind what it
    // made: they said no.
    if (settledRef.current) {
      if (result.status === 'ok' && walletAddress) removeBiometric(walletAddress)
      if (result.status === 'needs-confirm') abandonBiometricRegistration(result.pending)
      return
    }
    setWorking(false)
    if (result.status === 'needs-confirm') { setPending(result.pending); return }
    settledRef.current = true
    setPending(null)
    if (result.status === 'ok') {
      // Only now - the credential exists, the passcode is sealed, and a real
      // unlock (the verification test) reproduced it.
      useAuthStore.getState().setBiometricEnabled(true)
      showToastMessage(reseal ? `${label} is on for your new passcode` : `${label} enabled`, 'success')
    } else {
      // Nothing was stored - the passcode keeps working exactly as before.
      // A cancel counts as "not now" for the 24h unlock-offer cooldown.
      if (walletAddress) recordBiometricOfferSkip(walletAddress)
      showToastMessage(biometricFailureMessage(result.reason, label), result.reason === 'cancelled' ? 'info' : 'error')
    }
    navigate(nextPath, { replace: true })
  }

  const handleEnable = async () => {
    const p = pendingRef.current
    if (!walletAddress || (!rawPasscode && !p)) { navigate(nextPath, { replace: true }); return }
    setWorking(true)
    settle(p
      ? await confirmBiometricRegistration(p)
      : await registerBiometric(walletAddress, rawPasscode, user?.displayName || user?.username || 'MeshPort user'))
  }

  const handleSkip = () => {
    settledRef.current = true
    if (pendingRef.current) { abandonBiometricRegistration(pendingRef.current); setPending(null) }
    if (walletAddress) recordBiometricOfferSkip(walletAddress)
    navigate(nextPath, { replace: true })
  }

  if (supported !== true) return null // brief flash before the redirect-on-unsupported effect above fires

  return (
    <div className="flex flex-col h-full bg-bg px-6 py-safe">
      <div className="flex-1 flex flex-col items-center justify-center text-center gap-6">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
          transition={CONTROL_MOTION}
          className="w-24 h-24 rounded-full flex items-center justify-center bg-brand/15 border border-brand/25"
        >
          <Icon className="w-11 h-11 text-brand-text" />
        </motion.div>

        <div>
          <h2 className="text-[20px] tracking-[-0.2px] font-bold text-text-primary mb-2">{reseal ? `Keep ${label} on?` : `Enable ${label}?`}</h2>
          <p className="text-text-secondary text-[14px] leading-[1.5] max-w-xs mx-auto">
            {reseal
              ? <>Your passcode changed. Confirm with {label} once to keep using it - otherwise it turns off and your passcode works as usual.</>
              : pending
              ? <>One more step: confirm with {label} once more to finish turning it on.</>
              : <>Unlock MeshPort and approve transactions faster using {label} instead of your passcode.
                Your passcode still works anytime as a fallback.</>}
          </p>
          <p className="text-text-secondary text-[12px] leading-[1.5] max-w-xs mx-auto mt-2 opacity-80">
            Your device decides how it checks it&apos;s you - it may also accept its own screen-lock PIN or passcode.
          </p>
        </div>

        {apple && !pending && (
          <div className="w-full max-w-xs rounded-2xl px-4 py-3 text-left text-[13px] leading-[1.5]"
            style={{ background: 'color-mix(in srgb, var(--brand) 9%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 22%, transparent)', color: 'var(--text-secondary)' }}>
            <p className="font-semibold text-text-primary mb-1">Apple will ask to "Save a passkey"</p>
            On iPhone, iPad and Mac, websites use {label} through a passkey, so Apple shows its passkey screen first. Tap <b>Continue</b>, then use {label}.
            It only lets {label} unlock MeshPort on this device - it can't open your wallet or move money on its own.
          </div>
        )}

        <div className="w-full max-w-xs space-y-3 mt-4">
          <button onClick={handleEnable} disabled={working}
            className="w-full py-4 bg-brand rounded-2xl text-white font-bold shadow-elevation-2 active:scale-[.98] transition-transform disabled:opacity-60 border border-black/10">
            {working ? 'Checking…' : pending ? `Confirm with ${label}` : `Enable ${label}`}
          </button>
          <button onClick={handleSkip}
            className="w-full py-4 bg-transparent text-text-secondary font-semibold active:scale-[.98] transition-transform">
            Skip for now
          </button>
        </div>
      </div>
    </div>
  )
}
