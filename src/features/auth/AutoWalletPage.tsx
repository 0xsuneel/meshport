import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { CheckCircle, AlertTriangle } from 'lucide-react'
import { useAuthStore, useWalletStore } from '@/store'
import { generateWallet } from '@/lib/arc'

export function AutoWalletPage() {
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const username = useAuthStore(s => s.username)
  const loginType = useAuthStore(s => s.loginType)
  const setWallet = useAuthStore(s => s.setWallet)
  const { setBalance } = useWalletStore()
  const [step, setStep] = useState<'creating' | 'done'>('creating')
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  // How many times generation has failed in a row — after a couple of
  // failures, offer the manual create/import screen as an explicit,
  // clearly-labeled CHOICE rather than something the user gets silently
  // swept into. Social accounts almost never actually need this escape
  // hatch (retrying a transient server error usually just works), but it
  // exists so nobody gets permanently stuck if the server-side path is
  // down for a while.
  const [failureCount, setFailureCount] = useState(0)

  useEffect(() => { createWallet() }, [])

  const createWallet = async () => {
    setError('')
    setStep('creating')
    try {
      const isSocial = loginType === 'social'

      if (isSocial) {
        // Social-login accounts (Google + Email OTP, unified): the private
        // key is generated SERVER-SIDE (see supabase/functions/wallet-key,
        // action=generate-wallet) — never in this browser, never shown in
        // the UI. The server envelope-encrypts it immediately (random
        // per-wallet MEK, MEK encrypted under the server KEK — see
        // wallet_vault) and stores only ciphertext, then returns the
        // plaintext key back in this one response so it can be held in
        // memory here to sign locally, same as every other wallet type in
        // this app. It is NEVER cached to localStorage/sessionStorage
        // keyed by the app passcode — that's what lets the passcode be a
        // pure app-lock (see PasscodeSetupPage) that the user can freely
        // change on every login without touching the wallet at all.
        //
        // No passkey, no WebAuthn, no recovery-phrase fallback screen —
        // deliberately removed after passkey-based restoration proved
        // unreliable in practice (network-timing sensitivity, OS-level
        // passkey state, browser user-gesture requirements). Read the
        // security tradeoff documented at the top of that Edge Function
        // before assuming this is equivalent to a self-custodial wallet —
        // it isn't. The relevant WALLET_MASTER_KEK_V<n> plus a database
        // dump of wallet_vault together CAN reconstruct this account's
        // key (see docs/SECURITY_ARCHITECTURE.md for exactly how that
        // blast radius is contained per-wallet and per-KEK-version).
        // Accepted deliberately, for reliability, not an oversight.
        const { supabase } = await import('@/lib/supabase')
        const { getDeviceId } = await import('@/lib/deviceId')
        const { data, error } = await supabase.functions.invoke('wallet-key', {
          body: { action: 'generate-wallet', device_id: getDeviceId() },
        })
        if (error || !data?.address || !data?.privateKey) {
          // BUG FIX: see lib/describeFunctionsError.ts — error.message here
          // used to always be the SDK's generic "Edge Function returned a
          // non-2xx status code", hiding the real reason wallet-key's own
          // response body carried (e.g. a rate-limit or authorization
          // rejection) — same class of bug traced live from a Swap failure.
          const { describeFunctionsError } = await import('@/lib/describeFunctionsError')
          const reason = error ? await describeFunctionsError(error, 'Server wallet generation failed') : 'Server wallet generation failed'
          throw new Error(reason)
        }

        setWallet(data.address, data.privateKey, undefined, 'social-auto')
        setBalance(0)
        setAddress(data.address)
      } else {
        // create-wallet accounts: unchanged — generated locally, shown a
        // recovery phrase (elsewhere in the create-wallet flow, not here),
        // never sent to any server in any form.
        const wallet = await generateWallet()
        setWallet(wallet.address, wallet.privateKey, wallet.mnemonic, 'create')
        setBalance(0)
        setAddress(wallet.address)
      }

      setStep('done')
      await new Promise(r => setTimeout(r, 1200))
      navigate(username ? '/' : '/auth/claim-username', { replace: true })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Something went wrong creating your wallet.'
      console.error('[AutoWallet] Failed:', e)
      // Stay on THIS screen rather than silently redirecting to the
      // create/import chooser — that screen is for self-custodial
      // accounts and has nothing to do with a social-login account whose
      // server-side generation happened to fail once. The person already
      // chose Google/Email login; bouncing them to "create or import a
      // wallet" (options they never asked for, that don't apply to their
      // account type) was confusing and unexplained. Retrying in place
      // covers the common case (a transient error); the manual-setup
      // link only appears, and is only ever reached, by the user's own
      // explicit click after repeated failures — never automatically.
      setError(message)
      setFailureCount(c => c + 1)
    }
  }

  return (
    <div className="flex flex-col h-full bg-bg items-center justify-center px-6">
      {error ? (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 bg-danger/15 rounded-full flex items-center justify-center mx-auto">
            <AlertTriangle className="w-7 h-7 text-danger" />
          </div>
          <div>
            <h2 className="text-[20px] tracking-[-0.2px] font-bold text-text-primary">Couldn't create your wallet</h2>
            <p className="text-danger text-sm mt-2 break-words">{error}</p>
          </div>
          <div className="space-y-2 pt-2">
            <button
              onClick={createWallet}
              className="w-full py-3 rounded-2xl bg-brand text-white font-bold shadow-elevation-2 active:scale-[0.98] transition-transform border border-black/10"
            >
              Try Again
            </button>
            {failureCount >= 2 && loginType === 'social' && (
              <button
                onClick={() => navigate('/auth/wallet-setup', { replace: true })}
                className="w-full py-2 text-xs text-text-secondary underline"
              >
                Set up a wallet manually instead
              </button>
            )}
          </div>
        </motion.div>
      ) : step === 'creating' ? (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center space-y-6">
          <div className="w-20 h-20 bg-brand/15 rounded-full flex items-center justify-center mx-auto">
            <div className="w-10 h-10 border-2 border-brand border-t-transparent rounded-full animate-spin" />
          </div>
          <div>
            <h2 className="text-[20px] tracking-[-0.2px] font-bold text-text-primary">Setting up your wallet</h2>
            <p className="text-text-secondary mt-1 text-[14px] leading-[1.5]">Creating your secure Arc wallet...</p>
          </div>
        </motion.div>
      ) : (
        <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="text-center space-y-4">
          <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', delay: 0.1 }}
            className="w-20 h-20 bg-success/15 rounded-full flex items-center justify-center mx-auto">
            <CheckCircle className="w-12 h-12 text-success" />
          </motion.div>
          <div>
            <h2 className="text-[20px] tracking-[-0.2px] font-bold text-text-primary">Wallet Ready!</h2>
            {address && <p className="text-xs font-mono text-text-secondary mt-1 break-all px-4">{address}</p>}
          </div>
        </motion.div>
      )}
    </div>
  )
}

