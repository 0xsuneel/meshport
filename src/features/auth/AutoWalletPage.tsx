import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ScreenPush } from '@/components/ui/ScreenPush'
import { EASE_OUT } from '@/lib/motion'
import { CheckCircle, AlertTriangle } from 'lucide-react'
import { useAuthStore, useWalletStore } from '@/store'

export function AutoWalletPage() {
  const navigate = useNavigate()
  const username = useAuthStore(s => s.username)
  const loginType = useAuthStore(s => s.loginType)
  const setWallet = useAuthStore(s => s.setWallet)
  const { setBalance } = useWalletStore()
  const [step, setStep] = useState<'creating' | 'done'>('creating')
  // Google / email: what this screen is waiting for right now.
  const [note, setNote] = useState('Creating your secure Arc wallet...')
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')

  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately re-runs only on the listed values
  useEffect(() => { createWallet() }, [])

  const createWallet = async () => {
    setError('')
    setStep('creating')
    try {
      const isSocial = loginType === 'social'

      if (isSocial) {
        // Google / email accounts get a Circle user-controlled wallet
        // (src/wallet/circle.ts): Circle keeps the key; the person signs in to
        // Circle the way they sign in to MeshPort (Google - already done at
        // sign-in - or Circle's email code), and the app's passcode /
        // biometric approves every signature. A failure stays on this screen
        // with Try Again; the reason goes to client_errors.
        const circle = await import('@/wallet/circle')
        if (!circle.circleConfigured()) throw new Error('Wallets are not available right now. Please try again later.')
        try {
          if (!(await circle.hasCircleSession())) {
            setNote(await circle.meshportProvider() === 'google' ? 'Signing in to your wallet with Google...' : 'Enter the code Circle emailed you to open your wallet.')
            if (await circle.signInToCircle(window.location.pathname) === 'redirected') return // back here after Google
          }
          setNote('Creating your secure Arc wallet...')
          const circleAddr = await circle.ensureCircleWallet()
          const account = await circle.restoreCircleAccount(circleAddr)
          if (!account) throw new Error('Your wallet did not open')
          setWallet(circleAddr, account, 'circle')
          setBalance(0)
          setAddress(circleAddr)
        } catch (e) {
          void import('@/lib/errorReport').then(r => r.reportClientError('rejection', new Error(`[circle wallet] ${e instanceof Error ? e.message : String(e)}`))).catch(() => {})
          throw new Error(e instanceof Error && /code|expired|cancel/i.test(e.message) ? e.message : "Couldn't set up your wallet. Check your connection and try again.")
        }
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
            <p className="text-text-secondary mt-1 text-[14px] leading-[1.5]">{loginType === 'social' ? note : 'Creating your secure Arc wallet...'}</p>
          </div>
        </div>
      ) : (
        <div className="text-center space-y-4">
          <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.22, ease: EASE_OUT, delay: 0.1 }}
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

