import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Copy, Loader2, ShieldCheck, Wallet } from 'lucide-react'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { copyToClipboard } from '@/lib/utils'
import { useAuthStore } from '@/store'
import {
  circleCall, circleConfigured, circleGoogleConfigured, CircleError, finishGoogleSignIn,
  loadCircleSession, meshportAccount, pendingSignInReturn, signOutCircle, startGoogleSignIn,
} from '@/wallet/circle'

// ── Circle wallet ─────────────────────────────────────────────────────────────
// Profile → Circle wallet. Shows whether this account's MeshPort wallet is its
// Circle wallet (docs/CIRCLE_WALLETS.md) and lets the user sign in to Circle
// again on this device when the Circle session has ended. Payments use the
// app's normal screens: a Circle wallet signs through src/wallet/circle.ts,
// approved with the MeshPort passcode / biometric - Circle shows no screen of
// its own (Confirmation UIs are off in Circle Console).

type Phase = 'loading' | 'off' | 'meshport' | 'signin' | 'ready'

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong') || 'Something went wrong'

export function CircleWalletPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const walletSource = useAuthStore(s => s.walletSource)
  const [phase, setPhase] = useState<Phase>('loading')
  const [uid, setUid] = useState<string | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!circleConfigured()) { setPhase('off'); return }
      const a = await meshportAccount()
      if (cancelled) return
      if (!a || a.anonymous) { setPhase('meshport'); return }
      setUid(a.uid)
      if (!loadCircleSession(a.uid)) { setPhase('signin'); return }
      try {
        const w = await circleCall<{ address: string }>(a.uid, 'wallet')
        if (!cancelled) { setAddress(w.address); setPhase('ready') }
      } catch (e) {
        if (cancelled) return
        if (e instanceof CircleError && e.code === 'no-wallet') { setPhase('ready'); return }
        if (e instanceof CircleError && e.code === 'session') { setPhase('signin'); return }
        setError(errorText(e)); setPhase('ready')
      }
    })()
    return () => { cancelled = true }
  }, [])

  async function signIn() {
    if (!uid) return
    setError(null); setBusy(true)
    try { await startGoogleSignIn({ meshport: false, uid, returnTo: '/circle-wallet' }) } // the page leaves for Google
    catch (e) { setError(errorText(e)); setBusy(false) }
  }

  function signOut() {
    if (!uid) return
    signOutCircle(uid); setAddress(null); setPhase('signin')
  }

  const inUse = walletSource === 'circle' && !!address && walletAddress?.toLowerCase() === address.toLowerCase()

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="header-row sticky top-0 z-20 bg-bg justify-between px-5 pt-header pb-header">
        <div className="flex items-center gap-3">
          {!isDesktop && (
            <button onClick={() => navigate(-1)} className="back-btn" aria-label="Back">
              <ArrowLeft className="w-5 h-5 text-text-primary" />
            </button>
          )}
          <h1 className="text-xl font-bold text-text-primary">Circle wallet</h1>
          <span className="text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-warning/20 text-warning">Testnet</span>
        </div>
      </div>

      <div className="px-5 pb-8 pt-2 space-y-4 lg:max-w-[760px] lg:mx-auto">
        <div className="bg-surface border border-border rounded-3xl p-5 flex gap-4">
          <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center flex-shrink-0">
            <Wallet className="w-5 h-5 text-accent-text" />
          </div>
          <div className="min-w-0 space-y-2">
            <p className="text-sm font-semibold text-text-primary">A wallet you can&apos;t lose</p>
            <p className="text-sm text-text-secondary leading-relaxed">
              Circle keeps this wallet&apos;s key, split so no single piece can sign. You open it by signing in with
              Google - on a new phone too. You approve every payment here in MeshPort with your passcode, Face ID
              or fingerprint; Circle doesn&apos;t show a second confirmation screen.
            </p>
          </div>
        </div>

        {error && <p role="alert" className="text-sm text-danger px-1">{error}</p>}

        {phase === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-text-secondary px-1"><Loader2 className="w-4 h-4 animate-spin" /> Checking your Circle wallet…</div>
        )}

        {phase === 'off' && (
          <div className="bg-surface border border-border rounded-3xl p-5">
            <p className="text-sm text-text-secondary">Circle wallets aren&apos;t switched on yet.</p>
          </div>
        )}

        {phase === 'meshport' && (
          <div className="bg-surface border border-border rounded-3xl p-5">
            <p className="text-sm text-text-secondary">Sign in to MeshPort with Google to use a Circle wallet.</p>
          </div>
        )}

        {phase === 'signin' && (
          <div className="bg-surface border border-border rounded-3xl p-5 space-y-3">
            <p className="text-sm font-semibold text-text-primary">Sign in to your Circle wallet on this device</p>
            <p className="text-sm text-text-secondary">Use the same Google account as MeshPort.</p>
            {circleGoogleConfigured() && (
              <button className="btn-primary w-full py-3.5 flex items-center justify-center gap-2" disabled={busy} onClick={signIn}>
                {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Opening Google…</> : 'Continue with Google'}
              </button>
            )}
          </div>
        )}

        {phase === 'ready' && (
          <div className="bg-surface border border-border rounded-3xl p-5 space-y-3">
            <div className="flex items-center gap-2 text-success text-sm font-semibold">
              <ShieldCheck className="w-4 h-4" /> {inUse ? 'Your MeshPort wallet is this Circle wallet' : 'Signed in to Circle'}
            </div>
            {address ? (
              <div className="flex items-start gap-2">
                <p className="text-sm text-text-primary font-mono break-all flex-1">{address}</p>
                <button className="back-btn" aria-label="Copy address" onClick={() => copyToClipboard(address)}><Copy className="w-4 h-4 text-text-secondary" /></button>
              </div>
            ) : (
              <p className="text-sm text-text-secondary">No Circle wallet on this account yet.</p>
            )}
            {!inUse && (
              <p className="text-xs text-text-secondary">
                Your payments still use your current wallet. Moving existing accounts to Circle comes in a later step.
              </p>
            )}
            <button className="text-sm text-text-secondary underline" onClick={signOut}>Sign out of Circle on this device</button>
          </div>
        )}
      </div>
    </div>
  )
}

/** Google sends the user back here (CIRCLE_LOGIN_PATH) - from MeshPort's own
 *  Google sign-in or a Circle-only sign-in. Outside the app's gates on
 *  purpose: Google's answer is in the page address, and a lock screen or
 *  redirect first would lose it. */
export function CircleLoginReturnPage() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)
  const back = useRef('/auth')
  useEffect(() => {
    if (started.current) return
    started.current = true
    back.current = pendingSignInReturn()
    finishGoogleSignIn()
      .then(({ returnTo }) => navigate(returnTo, { replace: true }))
      .catch(async e => {
        // MeshPort couldn't use Google's answer: fall back to the classic
        // Google sign-in (one more Google screen) so signing in never breaks.
        if (e instanceof CircleError && e.code === 'meshport-login') {
          const { supabase } = await import('@/lib/supabase')
          const { error } = await supabase.auth.signInWithOAuth({
            provider: 'google', options: { redirectTo: `${window.location.origin}/auth/google`, queryParams: { prompt: 'select_account' } },
          })
          if (!error) return
        }
        setError(errorText(e))
      })
  }, [navigate])
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-bg px-6 text-center">
      {error ? (
        <>
          <p role="alert" className="text-sm text-danger">{error}</p>
          <button className="btn-primary px-6 py-3" onClick={() => navigate(back.current, { replace: true })}>Back</button>
        </>
      ) : (
        <p className="flex items-center gap-2 text-sm text-text-secondary"><Loader2 className="w-4 h-4 animate-spin" /> Signing you in…</p>
      )}
    </div>
  )
}
