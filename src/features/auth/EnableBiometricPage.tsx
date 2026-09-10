import { useEffect, useState, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Fingerprint, ScanFace } from 'lucide-react'
import { motion } from 'framer-motion'
import { useAuthStore, useUIStore } from '@/store'
import { isBiometricSupported, registerBiometric, biometricLabel, recordBiometricOfferSkip } from '@/lib/biometric'

/**
 * Shown right after a passcode is confirmed — for new signups (create/
 * import/social), for a returning login on a browser with no local
 * biometric registered yet (see PasscodeSetup.tsx's returning=1 flow and
 * PasscodeLockPage's unlock handler), and reused again from Settings'
 * "Confirm Passcode" sheet when the user turns the toggle on manually.
 * One single place that actually asks "enable biometric?", rather than
 * each entry point building its own version of this and drifting apart.
 * Always skippable — Skip is exactly as prominent as Enable.
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
  const rawPasscode: string = (location.state as any)?.rawPasscode ?? ''
  const label = biometricLabel()
  const Icon = label === 'Face ID' ? ScanFace : Fingerprint

  useEffect(() => {
    isBiometricSupported().then(setSupported)
  }, [])

  // Device genuinely doesn't support it — skip straight through rather
  // than showing a screen for a capability that isn't there. Checked async
  // on mount, so this only fires after we actually know one way or the
  // other, not optimistically.
  useEffect(() => {
    if (supported === false) navigate(nextPath, { replace: true })
  }, [supported, nextPath, navigate])

  const settledRef = useRef(false)

  const handleEnable = async () => {
    if (!walletAddress || !rawPasscode) { navigate(nextPath, { replace: true }); return }
    setWorking(true)
    const ok = await registerBiometric(walletAddress, rawPasscode, user?.displayName || user?.username || 'MeshPort user')
    // If the user already tapped Skip while this was still in flight (a
    // real possibility — this call can hang for the full WebAuthn timeout,
    // or longer if something OS/browser-level goes wrong, e.g. a browser's
    // own password-manager sync failing mid-flow), don't act on a result
    // that's arriving after they've already moved on. They're on a
    // different screen by now; navigating or toasting here would be
    // acting on a decision that's no longer relevant.
    if (settledRef.current) return
    settledRef.current = true
    setWorking(false)
    if (ok) {
      useAuthStore.getState().setBiometricEnabled(true)
      showToastMessage(`${label} enabled`, 'success')
    } else {
      // Cancelled the OS prompt, or genuinely failed — either way this is a
      // normal, expected outcome, not an error state. Just continue on;
      // they can always turn it on later from Settings. Treated the same
      // as an explicit Skip for the 24h unlock-offer cooldown below — a
      // cancelled OS prompt is a "not now" just as much as tapping Skip.
      if (walletAddress) recordBiometricOfferSkip(walletAddress)
      showToastMessage(`${label} not enabled — you can turn it on later in Settings`, 'info')
    }
    navigate(nextPath, { replace: true })
  }

  const handleSkip = () => {
    settledRef.current = true
    if (walletAddress) recordBiometricOfferSkip(walletAddress)
    navigate(nextPath, { replace: true })
  }

  if (supported !== true) return null // brief flash before the redirect-on-unsupported effect above fires

  return (
    <div className="flex flex-col h-full bg-bg px-6 py-safe">
      <div className="flex-1 flex flex-col items-center justify-center text-center gap-6">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', damping: 15 }}
          className="w-24 h-24 rounded-full flex items-center justify-center bg-brand/15 border border-brand/25"
        >
          <Icon className="w-11 h-11 text-brand" />
        </motion.div>

        <div>
          <h2 className="text-[20px] tracking-[-0.2px] font-bold text-text-primary mb-2">Enable {label}?</h2>
          <p className="text-text-secondary text-[14px] leading-[1.5] max-w-xs mx-auto">
            Unlock MeshPort and approve transactions faster using {label} instead of your passcode.
            Your passcode still works anytime as a fallback.
          </p>
        </div>

        <div className="w-full max-w-xs space-y-3 mt-4">
          <button onClick={handleEnable} disabled={working}
            className="w-full py-4 bg-brand rounded-2xl text-white font-bold shadow-elevation-2 active:scale-[.98] transition-transform disabled:opacity-60 border border-black/10">
            {working ? 'Checking…' : `Enable ${label}`}
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
