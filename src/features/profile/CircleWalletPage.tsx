import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Copy, ExternalLink, Loader2, Mail, ShieldCheck, Wallet } from 'lucide-react'
import { isAddress } from 'viem'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { copyToClipboard } from '@/lib/utils'
import { ARC_EXPLORER } from '@/lib/arc'
import { usePasscodeGate } from '@/features/business/passcodeGate'
import {
  circleCall, circleConfigured, circleGoogleConfigured, CircleError, emailLogin, executeChallenge,
  finishGoogleLogin, loadCircleSession, meshportAccount, signOutCircle, startGoogleLogin,
} from '@/wallet/circle'

// ── Circle wallet (testnet) ───────────────────────────────────────────────────
// Profile → Support → Circle wallet (testnet). Circle user-controlled wallets
// (docs/CIRCLE_WALLETS.md) before they replace anything: sign in to Circle
// with Google or an email code, create the Arc wallet, send a test payment.
// A payment is approved with the MeshPort passcode / biometric; Circle's own
// confirmation screens are off (Circle Console → Configurator → Wallet
// Security Settings), so the user is told that here. Separate from the
// user's main wallet; Arc testnet only.

type Phase = 'loading' | 'off' | 'meshport' | 'signin' | 'setup' | 'ready'
type Account = { uid: string; email: string | null }

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong') || 'Something went wrong'
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

export function CircleWalletPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const gate = usePasscodeGate()
  const [phase, setPhase] = useState<Phase>('loading')
  const [account, setAccount] = useState<Account | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [usdc, setUsdc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'google' | 'email' | 'create' | 'send' | null>(null)
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('0.01')
  const [status, setStatus] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)
  // One key per payment the user means to make: a retry after a network error
  // reuses it, so Circle never sends the same payment twice.
  const payKey = useRef<string>(crypto.randomUUID())

  /** A Circle call; an ended Circle session sends the user back to sign-in. */
  const call = useCallback(async <T,>(a: Account, action: string, body?: Record<string, unknown>): Promise<T> => {
    try { return await circleCall<T>(a.uid, action, body) } catch (e) {
      if (e instanceof CircleError && e.code === 'session') setPhase('signin')
      throw e
    }
  }, [])

  const refreshBalance = useCallback(async (a: Account) => {
    try {
      const r = await call<{ balances: Array<{ symbol: string; amount: string }> }>(a, 'balances')
      setUsdc(r.balances.find(b => b.symbol.toUpperCase() === 'USDC')?.amount ?? '0')
    } catch { setUsdc(null) }
  }, [call])

  /** Where this account stands: signed in to Circle? wallet made? */
  const load = useCallback(async (a: Account) => {
    if (!loadCircleSession(a.uid)) { setPhase('signin'); return }
    try {
      const w = await call<{ address: string }>(a, 'wallet')
      setAddress(w.address); setPhase('ready'); void refreshBalance(a)
    } catch (e) {
      if (e instanceof CircleError && e.code === 'no-wallet') { setPhase('setup'); return }
      if (e instanceof CircleError && e.code === 'session') return
      setError(errorText(e)); setPhase('signin')
    }
  }, [call, refreshBalance])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!circleConfigured()) { setPhase('off'); return }
      const a = await meshportAccount()
      if (cancelled) return
      if (!a || a.anonymous) { setPhase('meshport'); return }
      setAccount(a)
      await load(a)
    })()
    return () => { cancelled = true }
  }, [load])

  async function google() {
    if (!account) return
    setError(null); setBusy('google')
    try { await startGoogleLogin(account.uid, '/circle-wallet') } // the page leaves for Google
    catch (e) { setError(errorText(e)); setBusy(null) }
  }

  async function email() {
    if (!account?.email) return
    setError(null); setBusy('email')
    try { await emailLogin(account.uid, account.email); await load(account) }
    catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }

  async function create() {
    if (!account) return
    setError(null); setBusy('create')
    try {
      const r = await call<{ challengeId?: string; initialized?: true }>(account, 'initialize')
      if (r.challengeId) await executeChallenge(account.uid, r.challengeId)
      // Circle makes the wallet right after the challenge; it shows up within a few seconds.
      for (let i = 0; i < 15; i++) {
        try { const w = await call<{ address: string }>(account, 'wallet'); setAddress(w.address); setPhase('ready'); void refreshBalance(account); return }
        catch (e) { if (!(e instanceof CircleError && e.code === 'no-wallet')) throw e }
        await wait(1000)
      }
      setError('Your wallet is still being set up - check again in a minute')
    } catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }

  function send() {
    if (!account) return
    setError(null); setStatus(null); setTxHash(null)
    if (!isAddress(to)) { setError('Enter a valid 0x address to send to'); return }
    if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) { setError('Enter an amount like 0.01'); return }
    gate.ask('Approve payment', `Send ${amount} USDC to ${to.slice(0, 6)}…${to.slice(-4)}`, () => { void pay(account) })
  }

  async function pay(a: Account) {
    setBusy('send')
    const started = performance.now()
    try {
      const { challengeId } = await call<{ challengeId: string }>(a, 'transfer', { to, amount, idempotencyKey: payKey.current })
      setStatus('Approving…')
      await executeChallenge(a.uid, challengeId)
      payKey.current = crypto.randomUUID() // approved: the next payment is a new one
      setStatus('Sending…')
      let txId: string | null = null
      for (let i = 0; i < 60; i++) {
        if (!txId) {
          const c = await call<{ status: string; transactionIds: string[]; errorMessage: string | null }>(a, 'challenge', { challengeId })
          if (c.status === 'FAILED' || c.status === 'EXPIRED') throw new Error(c.errorMessage || 'Circle did not send it')
          txId = c.transactionIds[0] ?? null
        }
        if (txId) {
          const t = await call<{ state: string; txHash: string | null; errorReason: string | null }>(a, 'transaction', { id: txId })
          if (t.txHash) setTxHash(t.txHash)
          if (t.state === 'COMPLETE' || t.state === 'CONFIRMED') {
            setStatus(`Confirmed in ${((performance.now() - started) / 1000).toFixed(1)} s`)
            void refreshBalance(a); return
          }
          if (['FAILED', 'DENIED', 'CANCELLED'].includes(t.state)) throw new Error(t.errorReason || `Payment ${t.state.toLowerCase()}`)
        }
        await wait(1000)
      }
      setStatus('Sent - still waiting for confirmation')
    } catch (e) { setStatus(null); setError(errorText(e)) } finally { setBusy(null) }
  }

  function signOut() {
    if (!account) return
    signOutCircle(account.uid); setAddress(null); setUsdc(null); setPhase('signin')
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {gate.sheet}
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
              Google or an email code - on a new phone too. You approve every payment here in MeshPort with your
              passcode, Face ID or fingerprint; Circle doesn&apos;t show a second confirmation screen.
            </p>
            <p className="text-xs text-text-secondary leading-relaxed">A preview on Arc testnet, separate from your main wallet.</p>
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
            <p className="text-sm text-text-secondary">Sign in to MeshPort with Google or email to use a Circle wallet.</p>
          </div>
        )}

        {phase === 'signin' && account && (
          <div className="bg-surface border border-border rounded-3xl p-5 space-y-3">
            <p className="text-sm font-semibold text-text-primary">Sign in to your Circle wallet</p>
            <p className="text-sm text-text-secondary">Use the same Google account or email as MeshPort.</p>
            {circleGoogleConfigured() && (
              <button className="btn-primary w-full py-3.5 flex items-center justify-center gap-2" disabled={busy !== null} onClick={google}>
                {busy === 'google' ? <><Loader2 className="w-4 h-4 animate-spin" /> Opening Google…</> : 'Continue with Google'}
              </button>
            )}
            {account.email && (
              <button className="btn-secondary w-full py-3 flex items-center justify-center gap-2" disabled={busy !== null} onClick={email}>
                {busy === 'email' ? <><Loader2 className="w-4 h-4 animate-spin" /> Waiting for your code…</> : <><Mail className="w-4 h-4" /> Email a code to {account.email}</>}
              </button>
            )}
          </div>
        )}

        {phase === 'setup' && (
          <div className="bg-surface border border-border rounded-3xl p-5 space-y-3">
            <p className="text-sm text-text-secondary">Signed in to Circle. Create your Arc wallet - it takes a few seconds.</p>
            <button className="btn-primary w-full py-3.5 flex items-center justify-center gap-2" disabled={busy !== null} onClick={create}>
              {busy === 'create' ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating your wallet…</> : 'Create Circle wallet'}
            </button>
          </div>
        )}

        {phase === 'ready' && address && (
          <>
            <div className="bg-surface border border-border rounded-3xl p-5 space-y-3">
              <div className="flex items-center gap-2 text-success text-sm font-semibold"><ShieldCheck className="w-4 h-4" /> Circle wallet ready</div>
              <div className="flex items-start gap-2">
                <p className="text-sm text-text-primary font-mono break-all flex-1">{address}</p>
                <button className="back-btn" aria-label="Copy address" onClick={() => copyToClipboard(address)}><Copy className="w-4 h-4 text-text-secondary" /></button>
              </div>
              <p className="text-sm text-text-secondary">Balance: <span className="text-text-primary font-semibold">{usdc ?? '…'} USDC</span> <span className="text-xs">(Arc testnet)</span></p>
              <p className="text-xs text-text-secondary">To test a payment, first send a little testnet USDC to this address from your main wallet.</p>
            </div>

            <div className="bg-surface border border-border rounded-3xl p-5 space-y-3">
              <p className="text-sm font-semibold text-text-primary">Send a test payment</p>
              <input value={to} onChange={e => setTo(e.target.value.trim())} placeholder="Send to 0x…" spellCheck={false}
                className="w-full bg-bg border border-border rounded-2xl px-4 py-3 text-sm text-text-primary font-mono outline-none focus:border-accent" />
              <input value={amount} onChange={e => setAmount(e.target.value.trim())} inputMode="decimal" placeholder="Amount in USDC"
                className="w-full bg-bg border border-border rounded-2xl px-4 py-3 text-sm text-text-primary outline-none focus:border-accent" />
              <button className="btn-primary w-full py-3.5 flex items-center justify-center gap-2" disabled={busy !== null} onClick={send}>
                {busy === 'send' ? <><Loader2 className="w-4 h-4 animate-spin" /> {status ?? 'Sending…'}</> : `Send ${amount || '0'} USDC`}
              </button>
              {status && busy !== 'send' && <p className="text-sm text-success">{status}</p>}
              {txHash && (
                <a href={`${ARC_EXPLORER}/tx/${txHash}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-sm text-accent-text break-all">
                  View on ArcScan <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" />
                </a>
              )}
            </div>

            <button className="text-sm text-text-secondary underline px-1" onClick={signOut}>Sign out of Circle on this device</button>
          </>
        )}
      </div>
    </div>
  )
}

/** Google sends the user back here after a Circle sign-in (CIRCLE_LOGIN_PATH).
 *  Outside the app's gates on purpose: the sign-in result is in the page
 *  address, and a lock screen or redirect first would lose it. */
export function CircleLoginReturnPage() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    finishGoogleLogin()
      .then(({ returnTo }) => navigate(returnTo, { replace: true }))
      .catch(e => setError(errorText(e)))
  }, [navigate])
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-bg px-6 text-center">
      {error ? (
        <>
          <p role="alert" className="text-sm text-danger">{error}</p>
          <button className="btn-primary px-6 py-3" onClick={() => navigate('/circle-wallet', { replace: true })}>Back to Circle wallet</button>
        </>
      ) : (
        <p className="flex items-center gap-2 text-sm text-text-secondary"><Loader2 className="w-4 h-4 animate-spin" /> Finishing Circle sign-in…</p>
      )}
    </div>
  )
}
