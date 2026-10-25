import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ScreenPush } from '@/components/ui/ScreenPush'
import { EASE_OUT } from '@/lib/motion'
import { CheckCircle, AlertTriangle } from 'lucide-react'
import { useAuthStore, useWalletStore } from '@/store'

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

  useEffect(() => { createWallet() }, [])

  const createWallet = async () => {
    setError('')
    setStep('creating')
    try {
      const isSocial = loginType === 'social'

      if (isSocial) {
        // Google / email accounts get a Privy wallet (src/wallet/privy.ts):
        // Privy keeps the key in its secure hardware and opens it with the
        // MeshPort sign-in - nothing to back up, any device. The app's
        // passcode / biometric approves every signature. If Privy can't open
        // one, this screen's error + Try Again (a device-only wallet would have
        // no way back on another phone); the reason goes to client_errors.
        const privy = await import('@/wallet/privy')
        if (!privy.privyConfigured()) throw new Error('Wallets are not available right now. Please try again later.')
        const privyAddr = await privy.ensurePrivyWallet(30_000).catch(e => {
          void import('@/lib/errorReport').then(r => r.reportClientError('rejection', new Error(`[privy wallet] ${e instanceof Error ? e.message : String(e)}`))).catch(() => {})
          throw new Error("Couldn't set up your wallet. Check your connection and try again.")
        })
        setWallet(privyAddr, privy.privyAccount(privyAddr), 'privy')
        setBalance(0)
        setAddress(privyAddr)
      } else {
        // create-wallet accounts: unchanged - generated locally, shown a
        // recovery phrase (elsewhere in the create-wallet flow, not here),
        // never sent to any server in any form.
        const { createWallet: createFrameWallet } = await import('@/wallet')
        const signer = await createFrameWallet('create')
        setWallet(signer.address, signer, 'create')
        setBalance(0)
        setAddress(signer.address)
      }

      setStep('done')
      await new Promise(r => setTimeout(r, 1200))
      navigate(username ? '/' : '/auth/claim-username', { replace: true })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Something went wrong creating your wallet.'
      console.error('[AutoWallet] Failed:', e)
      // Stay on THIS screen rather than silently redirecting to the
      // create/import chooser - that screen is for self-custodial
      // accounts and has nothing to do with a social-login account whose
      // wallet setup happened to fail once. The person already
      // chose Google/Email login; bouncing them to "create or import a
      // wallet" (options they never asked for, that don't apply to their
      // account type) was confusing and unexplained. Retrying in place
      // covers the common case (a transient error).
      setError(message)
    }
  }

  return (
    <div className="flex flex-col h-full bg-bg px-6">
      {/* The page itself arrives with the route's push; creating → ready (or
          the error) pushes in like any step, with no fades of its own. */}
      <ScreenPush screenKey={error ? 'error' : step}>
      <div className="flex-1 flex flex-col items-center justify-center">
      {error ? (
        <div className="text-center space-y-4 max-w-sm">
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
          </div>
        </div>
      ) : step === 'creating' ? (
        <div className="text-center space-y-6">
          <div className="w-20 h-20 bg-brand/15 rounded-full flex items-center justify-center mx-auto">
            <div className="w-10 h-10 border-2 border-brand border-t-transparent rounded-full animate-spin" />
          </div>
          <div>
            <h2 className="text-[20px] tracking-[-0.2px] font-bold text-text-primary">Setting up your wallet</h2>
            <p className="text-text-secondary mt-1 text-[14px] leading-[1.5]">Creating your secure Arc wallet...</p>
          </div>
        </div>
      ) : (
        <div className="text-center space-y-4">
          <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ duration: 0.22, ease: EASE_OUT, delay: 0.1 }}
            className="w-20 h-20 bg-success/15 rounded-full flex items-center justify-center mx-auto">
            <CheckCircle className="w-12 h-12 text-success" />
          </motion.div>
          <div>
            <h2 className="text-[20px] tracking-[-0.2px] font-bold text-text-primary">Wallet Ready!</h2>
            {address && <p className="text-xs font-mono text-text-secondary mt-1 break-all px-4">{address}</p>}
          </div>
        </div>
      )}
      </div>
      </ScreenPush>
    </div>
  )
}

