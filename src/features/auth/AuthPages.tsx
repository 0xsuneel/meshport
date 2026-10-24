import { useState, useRef, useEffect } from 'react'
import { MeshPortLogo } from '@/components/ui/MeshPortLogo'
import { useStepDirection } from '@/hooks/useStepDirection'
import { useAutoFocus } from '@/hooks/useAutoFocus'
import { ScreenPush } from '@/components/ui/ScreenPush'
import { MOBILE_TAB_FADE_TRANSITION } from '@/lib/motion'
import { useNavigate, Navigate } from 'react-router-dom'
import {
  Mail, ArrowLeft, Eye, EyeOff, Copy, CheckCircle,
  AlertCircle, AlertTriangle, RefreshCw, XCircle, AtSign, Loader2,
  Sparkles, Download, Wallet, Lock, Link2, Zap, FileText, KeyRound, Store, User as UserIcon, ChevronRight,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card } from '@/components/ui/Card'
import { clearSocialDeviceState } from '@/lib/socialWallet'
import { useAuthStore, useWalletStore, useUIStore } from '@/store'
import { validateMnemonic } from '@/lib/arc'
import { createWallet, importWallet, walletStatus, checkRecoveryWords, setWalletPasscode, lockWallet, WalletFrameError, type WalletAccount } from '@/wallet'
import { WalletSecretFrame } from '@/components/wallet/WalletSecretFrame'
import { copySensitiveToClipboard } from '@/lib/utils'
import {
  supabase, upsertUserProfile,
  isUsernameTakenDb, getUserByWalletAddress, ensureAnonSession, resolveAccountForSession, lookupAccountByWallet,
  type DbUser,
} from '@/lib/supabase'
import { markWalletBackedUp } from '@/lib/security'
import { LoadingDots } from '@/components/ui/LoadingDots'
import {
  getSignupKind, getChosenKind, getAuthMode, setAuthIntent, clearAuthIntent, registerNameOnchain, type AccountKind,
} from '@/lib/onchainNames'
import { decideAccountAccess, foundAccountOf, type AuthMode, type AccessDecision } from '@/lib/accountRules'
import { AccountRuleNotice } from './AccountRuleNotice'
import { refreshMerchant } from '@/lib/merchant'
import type { User } from '@/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a stable UUID v5-like ID from a wallet address.
 * Same wallet address always produces the same UUID.
 * This lets wallet-only users have a consistent Supabase user ID across sessions.
 */
async function deriveWalletUserId(walletAddress: string): Promise<string> {
  const addr = walletAddress.toLowerCase().replace('0x', '')
  const encoder = new TextEncoder()
  const data = encoder.encode('meshport-wallet-user:' + addr)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  // Format as UUID v4 (random variant bits set)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    '4' + hex.slice(13, 16),   // version 4
    (parseInt(hex[16], 16) & 0x3 | 0x8).toString(16) + hex.slice(17, 20), // variant
    hex.slice(20, 32),
  ].join('-')
}
function makeUser(id: string, email: string, extra?: Partial<User>): User {
  return {
    id, email,
    username: '',
    displayName: email.split('@')[0],
    avatar: null,
    walletAddress: '',
    country: 'IN',
    createdAt: new Date().toISOString(),
    ...extra,
  }
}

/**
 * Builds the User patch to apply when a wallet being imported/re-entered
 * already has a registered MeshPort profile (see ClaimUsernamePage's
 * getUserByWalletAddress check). Lifted out to a pure, exported function
 * for the same reason mergeOnchainIntoRecords / dedupeAndSortActivityRecords
 * elsewhere in this app were: directly testable, no component mount needed.
 *
 * BUG FIX (2026-09-03): this used to only carry over id/username/
 * walletAddress from `existing`, silently dropping display_name and
 * avatar_url even though both are already present in the same query result
 * - GoogleAuthPage's equivalent restore (this same file, social-auto path)
 * does carry both over; this path just never matched it. A wallet
 * re-imported on a fresh device or after a reinstall would keep its correct
 * username but revert its profile picture and display name to blank/
 * default, even though the real values were one field away the whole time.
 */

// A fresh Google/email sign-in may set a new passcode on /auth/passcode?returning=1.
// The flag proves the page was reached from that sign-in (not typed by
// someone holding a locked device) - see RequireNoPasscode in App.tsx.
function markReturningSignIn() {
  try { sessionStorage.setItem('mp_returning_signin', String(Date.now())) } catch { /* private mode */ }
}

export function mergeExistingWalletProfile(
  user: User | null,
  walletAddress: string,
  existing: { id: string; username: string | null; display_name: string | null; avatar_url: string | null },
): User | null {
  if (!user) return user
  return {
    ...user,
    id: existing.id,
    username: existing.username + '.arc',
    walletAddress,
    displayName: existing.display_name || user.displayName,
    avatar: existing.avatar_url || user.avatar,
  }
}

// ─── Login Page ────────────────────────────────────────────────────────────────
// After login, check if there's a pending navigation from PayPage
function getAndClearReturnTo(): string | null {
  try {
    const v = sessionStorage.getItem('meshport_return_to')
    if (v) sessionStorage.removeItem('meshport_return_to')
    return v
  } catch { return null }
}


// ─── Entry: Create account / Log in + account type ──────────────────────────
// The very first choice, for BOTH paths. A business account claims a store
// username (sharmachai.arc) and its merchant application is sent at the same
// time; both kinds are registered on-chain (MeshPortNames). An account's type
// is fixed, so logging in asks for it too and refuses the other type (see
// src/lib/accountRules.ts).
function AccountKindPicker({ mode, onChoose, onSwitchMode }: {
  mode: AuthMode
  onChoose: (k: AccountKind) => void
  onSwitchMode: () => void
}) {
  const login = mode === 'login'
  const option = (k: AccountKind, icon: React.ReactNode, title: string, text: string) => (
    <button type="button" onClick={() => onChoose(k)}
      className="w-full flex items-center gap-4 text-left p-4 rounded-2xl bg-surface border border-border active:scale-[0.98] transition-transform hover:border-brand">
      <span className="w-12 h-12 rounded-2xl bg-brand/15 text-brand-text flex items-center justify-center flex-shrink-0">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-base font-bold text-text-primary">{title}</span>
        <span className="block text-sm text-text-secondary mt-0.5">{text}</span>
      </span>
      <ChevronRight className="w-5 h-5 text-text-secondary flex-shrink-0" />
    </button>
  )
  return (
    <div className="flex flex-col h-full bg-bg px-6 pt-16 pb-8">
      <div className="flex-1 flex flex-col justify-center max-w-sm mx-auto w-full">
        <div className="text-center mb-10">
          <MeshPortLogo className="w-20 h-20 mx-auto mb-5" />
          <h1 className="text-3xl font-bold text-text-primary">{login ? 'Welcome back' : 'MeshPort'}</h1>
          <p className="text-text-secondary mt-2">{login ? 'Which account are you logging in to?' : 'How will you use MeshPort?'}</p>
        </div>
        <div className="space-y-3">
          {login ? <>
            {option('personal', <UserIcon className="w-6 h-6" />, 'Personal account', 'Log in to your personal MeshPort account')}
            {option('business', <Store className="w-6 h-6" />, 'Business account', 'Log in to your business MeshPort account')}
          </> : <>
            {option('personal', <UserIcon className="w-6 h-6" />, 'Personal', 'Send, receive and swap USDC with friends')}
            {option('business', <Store className="w-6 h-6" />, 'Business', 'Everything in Personal, plus accept payments from customers')}
          </>}
        </div>
        <button type="button" onClick={onSwitchMode} className="mt-8 text-sm font-semibold text-brand-text text-center">
          {login ? 'New to MeshPort? Create an account' : 'I already have an account'}
        </button>
      </div>
    </div>
  )
}

export function LoginPage() {
  const navigate = useNavigate()
  const [agreed, setAgreed] = useState(false)
  // Circle's SDK and this browser's device id load while the user reads the
  // screen, so "Continue with Google" leaves for Google without waiting.
  useEffect(() => { void import('@/wallet/circle').then(c => c.warmCircle()).catch(() => {}) }, [])
  // First screen: Create account or Log in, and Personal or Business.
  const [mode, setMode] = useState<AuthMode>(() => getAuthMode())
  const [kind, setKind] = useState<AccountKind | null>(() => getChosenKind())
  const [choosing, setChoosing] = useState(() => getChosenKind() === null)
  const choose = (k: AccountKind) => { setAuthIntent(mode, k); setKind(k); setChoosing(false) }
  const switchMode = () => { const m: AuthMode = mode === 'login' ? 'create' : 'login'; setAuthIntent(m, null); setMode(m); setKind(null) }

  if (choosing || !kind) return <AccountKindPicker mode={mode} onChoose={choose} onSwitchMode={switchMode} />
  const login = mode === 'login'
  const isBiz = kind === 'business'

  const handleGoogleLogin = async () => {
    if (!agreed) return
    // With Circle wallets on, one Google screen signs in to MeshPort and the
    // Circle wallet together (src/wallet/circle.ts); Google sends the user to
    // /wallet/circle-login, which then continues at /auth/google below.
    const circle = await import('@/wallet/circle')
    if (circle.circleGoogleConfigured()) {
      try { await circle.startGoogleSignIn({ meshport: true }); return }
      catch (e) { console.error('[Auth] Google + Circle sign-in could not start; plain Google sign-in instead:', e) }
    }
    // signInWithOAuth redirects the whole page to Google, then back to
    // /auth/callback once the OAuth flow completes - the actual account
    // lookup/creation logic lives there (AuthCallbackPage below), not
    // here, since this function's own execution ends the moment the
    // redirect happens.
    //
    // queryParams.prompt: 'select_account' forces Google's account chooser
    // to show every time, even when the browser already has an active
    // Google session it could silently reuse - without this, Google skips
    // the picker and auto-signs into whichever account was last used,
    // which is exactly the behavior that was confusing on re-login (no
    // visible account choice, just an instant redirect into whatever
    // account happened to be active).
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/google`,
        queryParams: { prompt: 'select_account' },
      },
    })
    if (error) console.error('[Auth] Google sign-in failed:', error.message)
  }

  return (
    <div className="flex flex-col h-full bg-bg px-6 pt-16 pb-8">
      <div className="flex-1 flex flex-col items-center justify-center">
        <div className="text-center mb-8">
          <MeshPortLogo className="w-16 h-16 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-text-primary">
            {login ? 'Welcome back' : isBiz ? 'Set up your business' : 'Create your account'}
          </h1>
          <p className="text-text-secondary mt-2">
            {login ? `Log in to your ${isBiz ? 'business' : 'personal'} account`
              : isBiz ? 'Sign in, then claim your store username' : 'Sign in, then claim your username'}
          </p>
          <button type="button" onClick={() => { setAuthIntent(mode, null); setKind(null); setChoosing(true) }}
            className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-brand-text px-3 py-1.5 rounded-full bg-brand/10">
            {isBiz ? <Store className="w-3.5 h-3.5" /> : <UserIcon className="w-3.5 h-3.5" />}
            {login ? 'Log in' : 'New'} · {isBiz ? 'Business account' : 'Personal account'} · Change
          </button>
        </div>

        {/* Terms & Privacy - must be explicitly checked before any sign-up
            action is available. Previously this was just a passive line of
            text at the bottom ("By continuing you agree to...") with no
            actual consent mechanism - nothing required the person to read
            or acknowledge it, and it wasn't even a link. This makes
            agreement an explicit, required step instead. */}
        <motion.button
          type="button"
          onClick={() => setAgreed(a => !a)}
          className="w-full flex items-start gap-3 mb-5 text-left"
        >
          <span
            className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors"
            style={{
              background: agreed ? 'var(--brand)' : 'transparent',
              border: agreed ? 'none' : '1.5px solid var(--border)',
            }}
          >
            {agreed && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </span>
          <span className="text-xs text-text-secondary leading-relaxed">
            I agree to MeshPort's{' '}
            <span
              className="text-link underline"
              onClick={e => { e.stopPropagation(); navigate('/legal') }}
            >
              Terms of Service &amp; Privacy Policy
            </span>
          </span>
        </motion.button>

        <div className="w-full space-y-3">
          <button onClick={handleGoogleLogin} disabled={!agreed}
            className="w-full flex items-center justify-center gap-3 bg-text-primary/5 text-text-primary font-semibold py-4 rounded-2xl active:scale-95 transition-transform border border-border disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100">
            <GoogleIcon size={20} /> Continue with Google
          </button>
          <button onClick={() => agreed && navigate('/auth/email', { replace: true })}
            disabled={!agreed}
            className="w-full flex items-center justify-center gap-3 bg-brand text-white font-semibold py-4 rounded-2xl active:scale-95 transition-transform shadow-elevation-2 border border-black/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100">
            <Mail className="w-5 h-5" /> Continue with Email OTP
          </button>
          <div className="flex items-center gap-3 my-1">
            <div className="flex-1 h-px bg-text-primary/10" />
            <span className="text-xs text-text-secondary">OR</span>
            <div className="flex-1 h-px bg-text-primary/10" />
          </div>
          {/* A brand-new wallet never has an account - Create account only. */}
          {!login && (
            <button onClick={() => agreed && navigate('/auth/passcode?next=create')}
              disabled={!agreed}
              className="w-full flex items-center justify-center gap-3 bg-surface border border-border text-text-primary font-semibold py-4 rounded-2xl active:scale-95 transition-transform disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100">
              <Sparkles className="w-5 h-5" /> Create New Wallet
            </button>
          )}
          <button onClick={() => agreed && navigate('/auth/passcode?next=import')}
            disabled={!agreed}
            className="w-full flex items-center justify-center gap-3 bg-surface border border-border text-text-primary font-semibold py-4 rounded-2xl active:scale-95 transition-transform disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100">
            <Download className="w-5 h-5" /> {login ? 'Log in with Wallet' : 'Import Existing Wallet'}
          </button>
          <div className="flex items-center justify-center gap-2 pt-2">
            <motion.span
              animate={{ scale: [1, 1.5, 1], opacity: [1, 0.5, 1] }}
              transition={{ duration: 1.1, repeat: Infinity }}
              className="w-2 h-2 rounded-full bg-success flex-shrink-0"
            />
            <span className="text-xs text-text-secondary">Built On Arc Testnet</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Google OAuth Callback ───────────────────────────────────────────────────
// Reached after Google redirects back post-authentication (reuses the
// existing /auth/google route - this used to just show a "coming soon"
// toast and bounce back to /auth). Mirrors verifyOTP's existing/new-user
// logic intentionally, not by accident - Google and Email OTP are two
// different ways to verify the SAME kind of thing (a real email address),
// and must produce identical account behavior for the same email: same
// lookup, same wallet, no duplicate account just because a different
// button was tapped.
// Another MeshPort account already uses this email, but this sign-in isn't
// linked to it - never merged silently (see resolveAccountForSession).
const ACCOUNT_CONFLICT_MESSAGE =
  'This email already belongs to a MeshPort account that this sign-in isn\'t linked to. Sign in with the method you used to create that account.'

/**
 * Applies the account-type rules to a Google / email-code sign-in once its
 * account is known. 'allow' → go on; otherwise the caller shows the notice
 * (the session is kept until the person picks an option, so "Continue as
 * Business" / "Log in as Personal" needs no second sign-in).
 */
function decideForSession(existing: DbUser | null): AccessDecision {
  return decideAccountAccess(getChosenKind(), foundAccountOf(existing), getAuthMode())
}

type BlockedDecision = Exclude<AccessDecision, { kind: 'allow' }>

/** Shared by Google and email-code sign-in: the notice and what its buttons do. */
function useSessionRuleNotice(enterExisting: () => void) {
  const navigate = useNavigate()
  const [blocked, setBlocked] = useState<BlockedDecision | null>(null)
  const leave = async (to: { mode: AuthMode; kind: AccountKind | null }) => {
    await supabase.auth.signOut({ scope: 'local' }).catch(() => {})
    setAuthIntent(to.mode, to.kind)
    navigate('/auth', { replace: true })
  }
  const notice = blocked && (
    <AccountRuleNotice
      decision={blocked}
      via="login"
      onContinue={() => {
        if (blocked.kind === 'no_account') { void leave({ mode: 'create', kind: null }); return }
        // The account's real type, on the Log in path.
        setAuthIntent('login', blocked.existing)
        setBlocked(null)
        enterExisting()
      }}
      onBack={() => { void leave({ mode: getAuthMode(), kind: getChosenKind() }) }}
    />
  )
  return { notice, setBlocked }
}

export function GoogleAuthPage() {
  const navigate = useNavigate()
  const setUser = useAuthStore(s => s.setUser)
  const setUsername = useAuthStore(s => s.setUsername)
  const setLoginType = useAuthStore(s => s.setLoginType)
  const [error, setError] = useState('')
  const pending = useRef<(() => void) | null>(null)
  const { notice, setBlocked } = useSessionRuleNotice(() => pending.current?.())

  useEffect(() => {
    (async () => {
      const { data, error: sessionErr } = await supabase.auth.getSession()
      const supaUser = data?.session?.user
      if (sessionErr || !supaUser) {
        setError('Google sign-in failed. Please try again.')
        setTimeout(() => navigate('/auth', { replace: true }), 1500)
        return
      }

      // The account this Google login belongs to - through the session's
      // own binding only, never by matching emails (see
      // resolveAccountForSession). Same lookup as the email-code login.
      const resolved = await resolveAccountForSession(supaUser.id, supaUser.email)
      if (resolved.kind === 'error') {
        setError("Couldn't reach MeshPort. Please try again.")
        setTimeout(() => navigate('/auth', { replace: true }), 2000)
        return
      }
      if (resolved.kind === 'conflict') {
        await supabase.auth.signOut({ scope: 'local' }).catch(() => {})
        setError(ACCOUNT_CONFLICT_MESSAGE)
        setTimeout(() => navigate('/auth', { replace: true }), 5000)
        return
      }
      const existing = resolved.kind === 'existing' ? resolved.user : null
      // An account whose wallet is its Circle wallet opens with the Circle signer.
      const circleSigner = existing?.wallet_address
        ? await import('@/wallet/circle').then(c => c.circleSignerFor(supaUser.id, existing.wallet_address!)).catch(() => null)
        : null

      const enterExisting = () => {
        if (!existing) return
        setLoginType('social')
        useWalletStore.getState().setBalance(0)
        setUser(makeUser(existing.id, supaUser.email || '', {
          username:      existing.username ? existing.username + '.arc' : '',
          displayName:   existing.display_name,
          walletAddress: existing.wallet_address,
          avatar:        existing.avatar_url || null,
        }))
        if (existing.username) setUsername((existing.username || '').replace(/\.arc$/, ''))
        // walletSource: 'social-auto' is set here (not just walletAddress) so
        // restoreWallet.ts knows this account is eligible for the server-side
        // key backup fallback if this device has no local key material.
        if (existing.wallet_address) useAuthStore.setState({ walletAddress: existing.wallet_address, walletSource: circleSigner ? 'circle' : 'social-auto' })
        if (circleSigner && existing.wallet_address) useAuthStore.getState().setWallet(existing.wallet_address, circleSigner, 'circle')
        // A new sign-in always unlocks the wallet with the passkey or
        // Recovery QR - never a copy left on this device from before.
        clearSocialDeviceState()
        clearAuthIntent()
        markReturningSignIn()
        navigate('/auth/passcode?returning=1', { replace: true })
      }
      pending.current = enterExisting

      // Account-type rules: Log in needs an account of the chosen type;
      // only Create account makes a new one.
      const decision = decideForSession(existing)
      if (decision.kind !== 'allow') { setBlocked(decision); return }

      if (existing) { enterExisting(); return }

      // New user (Create account) - identical starting point to verifyOTP's
      // new-user path. No 'next' param here on purpose: PasscodeSetup routes
      // loginType === 'social' straight to AutoWalletPage automatically, same
      // as the email OTP flow - adding next=create here would incorrectly
      // route through the manual create-wallet flow instead.
      setLoginType('social')
      setUser(makeUser(supaUser.id, supaUser.email || ''))
      navigate('/auth/passcode', { replace: true })
    })()
  }, [])

  if (notice) return notice
  return (
    <div className="flex flex-col items-center justify-center h-full bg-bg px-6 text-center">
      {error ? (
        <p role="alert" className="text-danger">{error}</p>
      ) : (
        <>
          <Loader2 className="w-8 h-8 text-brand-text animate-spin mb-4" />
          <p className="text-text-secondary">Signing you in…</p>
        </>
      )}
    </div>
  )
}

// ─── Email OTP ────────────────────────────────────────────────────────────────
export function EmailOTPPage() {
  const navigate = useNavigate()
  const setUser = useAuthStore(s => s.setUser)
  const setLoginType = useAuthStore(s => s.setLoginType)
  const setWallet = useAuthStore(s => s.setWallet)
  const setUsername = useAuthStore(s => s.setUsername)
  const passcode = useAuthStore(s => s.passcode)
  const { showToastMessage } = useUIStore()

  const [step, setStep] = useState<'email' | 'otp'>('email')
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState(['', '', '', '', '', ''])
  const [loading, setLoading] = useState(false)
  const [resendTimer, setResendTimer] = useState(0)
  const [error, setError] = useState('')
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])
  const pending = useRef<(() => void) | null>(null)
  const { notice, setBlocked } = useSessionRuleNotice(() => pending.current?.())

  useEffect(() => {
    if (resendTimer <= 0) return
    const t = setTimeout(() => setResendTimer(r => r - 1), 1000)
    return () => clearTimeout(t)
  }, [resendTimer])

  const sendOTP = async () => {
    const e = email.trim().toLowerCase()
    if (!e.includes('@') || !e.includes('.')) { setError('Please enter a valid email address'); return }
    setLoading(true); setError('')
    const { error: err } = await supabase.auth.signInWithOtp({
      email: e,
      options: { shouldCreateUser: true },
      // No emailRedirectTo = OTP mode (not magic link)
    })
    setLoading(false)
    if (err) { setError(err.message); return }
    setStep('otp'); setResendTimer(60)
    showToastMessage('OTP sent to ' + e, 'success')
  }

  const handleOtpKey = (i: number, val: string) => {
    // Handle paste of full 6-digit code
    if (val.length > 1) {
      const digits = val.replace(/\D/g, '').slice(0, 6).split('')
      const n = [...otp]
      digits.forEach((d, j) => { if (i + j < 6) n[i + j] = d })
      setOtp(n)
      inputRefs.current[Math.min(i + digits.length, 5)]?.focus()
      return
    }
    const n = [...otp]; n[i] = val.replace(/\D/g, ''); setOtp(n)
    if (val && i < 5) inputRefs.current[i + 1]?.focus()
  }

  const verifyOTP = async () => {
    const token = otp.join('')
    if (token.length !== 6) { setError('Please enter the 6-digit code'); return }
    setLoading(true); setError('')

    const { data, error: err } = await supabase.auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token,
      type: 'email',
    })
    if (err || !data.user) {
      setLoading(false)
      setError(err?.message || 'Invalid OTP. Please try again.')
      return
    }

    const supaUser = data.user

    // ── Returning user: restore full account ────────────────────────────────
    // The account this session is bound to (users.auth_uid). Google and
    // email-code logins reach the same account when Supabase has linked
    // them to the same auth user. An account that only has the same email
    // is never taken over (see resolveAccountForSession).
    const resolved = await resolveAccountForSession(supaUser.id, supaUser.email)
    if (resolved.kind === 'error') {
      setLoading(false)
      setError("Couldn't reach MeshPort. Please try again.")
      return
    }
    if (resolved.kind === 'conflict') {
      await supabase.auth.signOut({ scope: 'local' }).catch(() => {})
      setLoading(false)
      setError(ACCOUNT_CONFLICT_MESSAGE)
      return
    }
    const existing = resolved.kind === 'existing' ? resolved.user : null
    // An account whose wallet is its Circle wallet opens with the Circle signer.
    const circleSigner = existing?.wallet_address
      ? await import('@/wallet/circle').then(c => c.circleSignerFor(supaUser.id, existing.wallet_address!)).catch(() => null)
      : null

    const enterExisting = () => {
      if (!existing) return
      setLoginType('social')
      // Clear any prior wallet's transaction history before restoring this account
      useWalletStore.getState().setBalance(0)
      setUser(makeUser(existing.id, supaUser.email || '', {
        username:      existing.username ? existing.username + '.arc' : '',
        displayName:   existing.display_name,
        walletAddress: existing.wallet_address,
        avatar:        existing.avatar_url || null,
      }))
      if (existing.username) setUsername((existing.username || '').replace(/\.arc$/, ''))
      if (existing.wallet_address) {
        // Same reasoning as GoogleAuthPage above - tag walletSource so the
        // server-side key backup fallback is reachable on a fresh device.
        useAuthStore.setState({ walletAddress: existing.wallet_address, walletSource: circleSigner ? 'circle' : 'social-auto' })
        if (circleSigner) useAuthStore.getState().setWallet(existing.wallet_address, circleSigner, 'circle')
      }
      setLoading(false)
      showToastMessage(`Welcome back, ${existing.username || existing.display_name}! 👋`, 'success')
      // Returning user - set a new passcode (no old passcode needed), then
      // unlock the wallet with the passkey or Recovery QR (never a copy left
      // on this device from before this sign-in).
      clearSocialDeviceState()
      clearAuthIntent()
      markReturningSignIn()
      navigate('/auth/passcode?returning=1', { replace: true })
    }
    pending.current = enterExisting

    // Account-type rules: Log in needs an account of the chosen type; only
    // Create account makes a new one.
    const decision = decideForSession(existing)
    if (decision.kind !== 'allow') { setLoading(false); setBlocked(decision); return }

    // ── Returning user: restore full account ────────────────────────────────
    if (existing) { enterExisting(); return }

    // ── New user (Create account): start onboarding ─────────────────────────
    setLoginType('social')
    setUser(makeUser(supaUser.id, supaUser.email || ''))
    setLoading(false)
    showToastMessage('Email verified! Set up your account.', 'success')
    navigate('/auth/passcode', { replace: true })
  }

  if (notice) return notice

  return (
    <div className="flex flex-col h-full bg-bg px-6 py-12">
      <button onClick={() => step === 'otp' ? setStep('email') : navigate('/auth', { replace: true })}
        className="back-btn" style={{marginBottom:22}}>
        <ArrowLeft className="w-5 h-5 text-text-primary" />
      </button>
      {/* Email ⇄ code push like pages (no fade-out to an empty screen). */}
      <ScreenPush screenKey={step} back={step === 'email'}>
        {step === 'email' ? (
          <motion.div key="email" initial={false} className="space-y-6">
            <div>
              <h2 className="text-[20px] tracking-[-0.2px] font-bold text-text-primary">Sign in with Email</h2>
              <p className="text-text-secondary mt-1 text-[14px] leading-[1.5]">We'll send a 6-digit code to your email</p>
            </div>
            <Input label="Email Address" type="email" placeholder="you@gmail.com"
              value={email} onChange={e => { setEmail(e.target.value); setError('') }}
              error={error} leftIcon={<Mail className="w-4 h-4" />} />
            <Button fullWidth loading={loading} onClick={sendOTP}>Send OTP →</Button>
          </motion.div>
        ) : (
          <motion.div key="otp" initial={false} className="space-y-6">
            <div>
              <h2 className="text-[20px] tracking-[-0.2px] font-bold text-text-primary">Enter your code</h2>
              <p className="text-text-secondary mt-1 text-[14px] leading-[1.5]">Sent to <span className="text-text-primary font-medium">{email}</span></p>
            </div>
            <div className="flex gap-2 justify-center">
              {otp.map((digit, i) => (
                <input key={i} ref={el => inputRefs.current[i] = el}
                  type="text" inputMode="numeric" maxLength={6}
                  value={digit} onChange={e => handleOtpKey(i, e.target.value)}
                  onKeyDown={e => e.key === 'Backspace' && !otp[i] && i > 0 && inputRefs.current[i - 1]?.focus()}
                  onFocus={e => e.target.select()}
                  className={`w-12 h-14 text-center text-xl font-bold bg-surface rounded-2xl text-text-primary focus:outline-none transition-colors border-2 ${digit ? 'border-brand' : 'border-border focus:border-brand'}`} />
              ))}
            </div>
            {error && (
              <div role="alert" className="flex items-center gap-2 p-3 bg-danger/10 border border-danger/30 rounded-2xl">
                <AlertCircle className="w-4 h-4 text-danger flex-shrink-0" />
                <p className="text-sm text-danger">{error}</p>
              </div>
            )}
            <Button fullWidth loading={loading} onClick={verifyOTP} disabled={otp.join('').length !== 6}>
              {loading ? 'Verifying...' : 'Verify & Continue →'}
            </Button>
            <div className="text-center">
              {resendTimer > 0
                ? <p className="text-sm text-text-secondary">Resend in {resendTimer}s</p>
                : <button onClick={() => { sendOTP(); setOtp(['','','','','','']); setError('') }}
                    className="text-sm text-brand-text flex items-center gap-1 mx-auto">
                    <RefreshCw className="w-3.5 h-3.5" /> Resend OTP
                  </button>
              }
            </div>
            <p className="text-xs text-text-muted text-center">
              Check your inbox and spam folder. Code expires in 10 minutes.
            </p>
          </motion.div>
        )}
      </ScreenPush>
    </div>
  )
}

// ─── Wallet Setup (only shown to self-custody users) ─────────────────────────
export function WalletSetupPage() {
  const navigate = useNavigate()
  const logout = useAuthStore(s => s.logout)

  // Not a plain "back" link - /auth (the welcome screen) redirects anyone
  // who's still authenticated with a passcode set straight back to THIS
  // page (see RequireNoAuth in App.tsx), so a bare back-arrow would just
  // loop. Getting back to the welcome screen for real means undoing the
  // in-progress signup first: sign out (reuses the same logout() used
  // everywhere else in the app, which also revokes the underlying
  // Supabase session, not just local state) and drop the passcode. Framed
  // as "start over," not "back," so it's clear this discards progress
  // rather than harmlessly stepping back a screen.
  const handleCancel = () => {
    logout()
    navigate('/auth', { replace: true })
  }

  return (
    <div className="flex flex-col h-full bg-bg px-6 py-12">
      <div className="flex-1 flex flex-col items-center justify-center space-y-6">
        <div className="text-center">
          <div className="w-20 h-20 rounded-3xl bg-balance-gradient flex items-center justify-center mx-auto mb-5">
            <Wallet className="w-9 h-9 text-white" strokeWidth={1.8} />
          </div>
          <h2 className="text-2xl font-bold text-text-primary">Set up your wallet</h2>
          <p className="text-text-secondary mt-2">Passcode is set. Now create or import a wallet.</p>
        </div>
        <div className="w-full space-y-3">
          <Button fullWidth onClick={() => navigate('/auth/create-wallet', { replace: true })}><Sparkles className="w-4 h-4" /> Create New Wallet</Button>
          <Button fullWidth variant="outline" onClick={() => navigate('/auth/import-wallet', { replace: true })}><Download className="w-4 h-4" /> Import Existing Wallet</Button>
        </div>
        <button onClick={handleCancel} className="text-xs text-text-secondary underline pt-2">
          Cancel and start over
        </button>
      </div>
    </div>
  )
}

// ─── Create Wallet ─────────────────────────────────────────────────────────────
/** Three distinct, ascending word positions for the backup check. */
function pickVerifyIndexes(wordCount: number): number[] {
  const picked = new Set<number>()
  const rand = new Uint32Array(1)
  while (picked.size < 3) { crypto.getRandomValues(rand); picked.add(rand[0] % wordCount) }
  return [...picked].sort((a, b) => a - b)
}

export function CreateWalletPage() {
  const navigate = useNavigate()
  const setWallet = useAuthStore(s => s.setWallet)
  const setUser = useAuthStore(s => s.setUser)
  const setLoginType = useAuthStore(s => s.setLoginType)
  const user = useAuthStore(s => s.user)
  const isAuthenticated = useAuthStore(s => s.isAuthenticated)
  const username = useAuthStore(s => s.username)
  const passcode = useAuthStore(s => s.passcode)
  const { setBalance } = useWalletStore()
  const { showToastMessage } = useUIStore()
  const [step, setStep] = useState<'generate' | 'backup' | 'confirm' | 'success'>('generate')
  const createDir = useStepDirection(step, ['generate', 'backup', 'confirm', 'success'] as const)
  // The new wallet lives in the wallet frame (src/wallet): this page only
  // holds its address. The phrase is shown by the frame itself
  // (WalletSecretFrame) and the confirm words are checked there.
  const [walletData, setWalletData] = useState<{ address: string; signer: WalletAccount; wordCount: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirmWords, setConfirmWords] = useState<string[]>(['', '', ''])
  const [confirmError, setConfirmError] = useState('')
  // Three random positions, picked per wallet and only revealed on the verify
  // screen - one fixed, highlighted word could be noted without saving the rest.
  const [verifyIdx, setVerifyIdx] = useState<number[]>([])
  // No inline guards - handled entirely by RequireNoWallet in App.tsx router

  const handleGenerate = async () => {
    setLoading(true)
    try {
      const signer = await createWallet('create')
      const { wordCount } = await walletStatus(signer.address)
      setVerifyIdx(pickVerifyIndexes(wordCount || 12))
      setConfirmWords(['', '', ''])
      setWalletData({ address: signer.address, signer, wordCount: wordCount || 12 }); setStep('backup')
    } catch (e) {
      showToastMessage(e instanceof Error ? e.message : "Couldn't create a wallet", 'error')
    } finally { setLoading(false) }
  }

  const handleConfirm = async () => {
    if (!walletData) return
    const answers: Record<number, string> = {}
    verifyIdx.forEach((wi, i) => { answers[wi] = confirmWords[i] })
    let check: { ok: boolean; wrong: number[] }
    try { check = await checkRecoveryWords(walletData.address, answers) }
    catch (e) { setConfirmError(e instanceof Error ? e.message : "Couldn't check the words"); return }
    if (!check.ok) {
      const wrong = check.wrong.length ? check.wrong : verifyIdx
      setConfirmError(`${wrong.map(wi => `Word #${wi + 1}`).join(', ')} ${wrong.length > 1 ? 'are' : 'is'} incorrect. Check your backup.`); return
    }
    setConfirmError('')
    setWallet(walletData.address, walletData.signer, 'create')
    setBalance(0)
    // Create the local user id FIRST if needed - this used to run AFTER the
    // cloud-save check below, which meant `user` (captured from this
    // component's render, not updated by setUser() within this same
    // synchronous call) was still null for any brand-new self-custody
    // signup, silently skipping the cloud backup save entirely below. Doing
    // this first, then reading the fresh id via getState() (a live
    // snapshot, not the stale hook value) rather than the `user` closure,
    // fixes it for both this flow and the equivalent import flow.
    if (!isAuthenticated || !user) {
      setLoginType('wallet')
      setUser(makeUser('usr_' + Date.now(), ''))
    }
    // setUser() above already fires ensureAnonSession() itself, but only as
    // a fire-and-forget .then() chain - nothing actually waits for it. This
    // flow happened to get away with that because there's real elapsed time
    // between here and reaching any page that needs a working session (the
    // mnemonic backup + confirm-word screens the user has to get through
    // first). Import has no such screens - see the identical await in
    // handleImport below, where this was a genuine, reproducible race, not
    // just a theoretical one. Awaiting explicitly here too so both flows
    // are correct on their own merits rather than one leaning on the other
    // flow's incidental UI timing.
    try { await ensureAnonSession() } catch (e) { console.warn('[Wallet] ensureAnonSession failed:', e) }
    // Use RAW passcode from the in-memory stash (not the hashed version in store)
    const { getPendingRawPasscode } = await import('@/lib/restoreWallet')
    const rawPasscode = getPendingRawPasscode()
    if (rawPasscode) {
      try {
        // Local device storage only - in the wallet frame's origin. No
        // server-side copy of the key or the phrase is ever saved, by design:
        // if this device's storage and the user's own saved recovery phrase
        // are both lost, this wallet is unrecoverable. The frame keeps both
        // passcode-encrypted (and device-sealed) for BackupRecoveryPhrasePage.
        await setWalletPasscode(walletData.address, rawPasscode)
        // The word check on the previous screen proved the phrase was saved.
        await markWalletBackedUp(walletData.address)
      } catch (e) { console.warn('[Wallet] Local key backup failed:', e) }
      finally { const { clearRawPasscode } = await import('@/lib/restoreWallet'); clearRawPasscode() }
    }
    setStep('success')
  }

  return (
    <div className="flex flex-col h-full bg-bg px-6 py-12 overflow-y-auto">
      <button onClick={() => {
        if (step === 'generate') navigate(-1)
        else if (step === 'backup') setStep('generate')
        else if (step === 'confirm') { setStep('backup'); setConfirmWords(['', '', '']); setConfirmError('') }
      }} className="back-btn" style={{marginBottom:14}}>
        <ArrowLeft className="w-5 h-5 text-text-primary" />
      </button>
      <div className="flex gap-1.5 mb-8">
        {(['generate','backup','confirm','success'] as const).map((s, i) => {
          const idx = ['generate','backup','confirm','success'].indexOf(step)
          return <div key={s} className={`flex-1 h-1 rounded-full transition-all ${idx >= i ? 'bg-brand' : 'bg-text-primary/10'}`} />
        })}
      </div>
      {/* Steps push like pages, and back reverses (no fade-out to an empty
          screen in between). */}
      <ScreenPush screenKey={step} back={createDir === 'back'}>
        {step === 'generate' && (
          <motion.div key="gen" initial={false} className="space-y-6">
            <div><h2 className="text-2xl font-bold text-text-primary">Create New Wallet</h2><p className="text-text-secondary mt-1">BIP39 · 12-word seed phrase</p></div>
            <div className="space-y-3">
              {[{Icon:Lock,t:'BIP39 Standard',s:'Industry standard 12-word phrase'},{Icon:Link2,t:'Compatible',s:'MetaMask, Trust, OKX, Coinbase'},{Icon:Zap,t:'Arc Testnet Ready',s:'Chain ID 5042002'}].map(i => (
                <Card key={i.t} className="p-4 flex items-center gap-3">
                  <div className="w-10 h-10 bg-brand/15 rounded-xl flex items-center justify-center flex-shrink-0">
                    <i.Icon className="w-5 h-5 text-brand-text" strokeWidth={1.8} />
                  </div>
                  <div><p className="text-sm font-bold text-text-primary">{i.t}</p><p className="text-xs text-text-secondary">{i.s}</p></div>
                </Card>
              ))}
            </div>
            <Button fullWidth loading={loading} onClick={handleGenerate}>Generate Wallet</Button>
          </motion.div>
        )}
        {step === 'backup' && walletData && (
          <motion.div key="backup" initial={false} className="space-y-5">
            <div><h2 className="text-2xl font-bold text-text-primary">Save Recovery Phrase</h2><p className="text-text-secondary mt-1">Write down all 12 words, in order. Next you'll be asked for 3 of them.</p></div>
            <div className="p-3 bg-warning/10 border border-warning/30 rounded-2xl flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
              <p className="text-sm text-warning">Never share this. Anyone with it controls your wallet. Avoid taking a screenshot - write it down instead.</p>
            </div>
            {/* Rendered by the wallet frame - the phrase never enters the app. */}
            <WalletSecretFrame address={walletData.address} what="mnemonic" height={walletData.wordCount > 12 ? 360 : 260} />
            <Button fullWidth onClick={() => { setConfirmWords(['', '', '']); setConfirmError(''); setStep('confirm') }}>I've Written It Down →</Button>
          </motion.div>
        )}
        {step === 'confirm' && walletData && (
          <motion.div key="confirm" initial={false} className="space-y-6">
            <div><h2 className="text-2xl font-bold text-text-primary">Verify Your Backup</h2>
              <p className="text-text-secondary mt-1">Enter these 3 words from your recovery phrase</p></div>
            <div className="space-y-4">
              {verifyIdx.map((wi, i) => (
                <Input key={wi} label={`Word #${wi + 1}`} placeholder="Type the word..." value={confirmWords[i]}
                  onChange={e => { const v = e.target.value; setConfirmWords(ws => ws.map((w, j) => j === i ? v : w)); setConfirmError('') }}
                  autoFocus={i === 0} autoComplete="off" autoCapitalize="none" spellCheck={false} />
              ))}
            </div>
            {confirmError && <div role="alert" className="flex items-start gap-2 p-3 bg-danger/10 border border-danger/30 rounded-2xl"><XCircle className="w-4 h-4 text-danger mt-0.5" /><p className="text-sm text-danger">{confirmError}</p></div>}
            <Button fullWidth onClick={handleConfirm} disabled={confirmWords.some(w => !w.trim())}>Confirm & Create Wallet</Button>
          </motion.div>
        )}
        {step === 'success' && walletData && (
          <motion.div key="success" initial={false} className="space-y-6 text-center">
            <motion.div initial={{ scale: 0.6 }} animate={{ scale: 1 }} transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
              className="w-24 h-24 bg-success/20 rounded-full flex items-center justify-center mx-auto">
              <CheckCircle className="w-14 h-14 text-success" />
            </motion.div>
            <div><h2 className="text-2xl font-bold text-text-primary">Wallet Created! 🎉</h2><p className="text-text-secondary mt-1">Arc Testnet ready</p></div>
            <Card className="p-4 text-left"><div><p className="text-xs text-text-secondary mb-1">Wallet Address</p><p className="text-xs font-mono text-text-primary break-all">{walletData.address}</p></div></Card>
            <Button fullWidth onClick={() => {
              showToastMessage('Wallet created!', 'success')
              // Always go to claim-username - the guard there handles existing profiles
              navigate('/auth/claim-username', { replace: true })
            }}>Continue →</Button>
          </motion.div>
        )}
      </ScreenPush>
    </div>
  )
}

// ─── Import Wallet ─────────────────────────────────────────────────────────────
export function ImportWalletPage() {
  const navigate = useNavigate()
  const setWallet = useAuthStore(s => s.setWallet)
  const setUser = useAuthStore(s => s.setUser)
  const setLoginType = useAuthStore(s => s.setLoginType)
  const user = useAuthStore(s => s.user)
  const isAuthenticated = useAuthStore(s => s.isAuthenticated)
  const username = useAuthStore(s => s.username)
  const passcode = useAuthStore(s => s.passcode)
  const existingWalletAddress = useAuthStore(s => s.walletAddress)
  // Google / email sign-ins hold one MeshPort account per login, so switching
  // that account to a different wallet (= a different account) can't work.
  const isSocialLogin = useAuthStore(s => s.loginType) === 'social'
  const { setBalance } = useWalletStore()
  const { showToastMessage } = useUIStore()
  const [method, setMethod] = useState<'mnemonic' | 'privatekey'>('mnemonic')
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showKey, setShowKey] = useState(false)
  const wordCount = input.trim() ? input.trim().split(/\s+/).length : 0

  // Set only when an ALREADY-EXISTING wallet's address doesn't match what
  // was just imported - e.g. this page was reached via the "restore your
  // wallet" recovery banner and the user pasted the wrong phrase/key (a
  // personal MetaMask/OKX one, say, instead of the one MeshPort actually
  // showed them). Deliberately does NOT fire for a fresh signup with no
  // wallet yet - existingWalletAddress is null/empty there, so the import
  // proceeds exactly as it always has, no extra step, no warning.
  const [mismatch, setMismatch] = useState<{
    result: { address: string; signer: WalletAccount }
    walletSource: 'import-seed' | 'import-privkey'
  } | null>(null)

  // Set when the wallet's account doesn't fit the chosen path (see
  // src/lib/accountRules.ts). Nothing is saved until the person picks an option.
  const [blocked, setBlocked] = useState<{
    decision: BlockedDecision
    result: { address: string; signer: WalletAccount }
    walletSource: 'import-seed' | 'import-privkey'
  } | null>(null)

  // The typed phrase / key went into the wallet frame, open only in memory
  // and this tab's session copy. Backing out closes it again.
  const discardImport = (r: { address: string } | null | undefined) => { if (r) void lockWallet(r.address) }

  // No inline guards - handled entirely by RequireNoWallet in App.tsx router

  const handleImport = async () => {
    setError(''); setLoading(true)
    let secret = ''
    if (method === 'mnemonic') {
      const v = validateMnemonic(input)
      if (!v.valid) { setError(!([12,15,18,21,24].includes(v.wordCount)) ? `Need 12 words, got ${v.wordCount}.` : `Invalid characters in words: ${v.invalidWords.slice(0,3).join(', ')} - use only letters`); setLoading(false); return }
      secret = input.trim()
    } else {
      const cleaned = input.trim().replace(/^0x/, '')
      if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) { setError('Private key must be 64 hex characters.'); setLoading(false); return }
      secret = '0x' + cleaned
    }
    const walletSource = method === 'mnemonic' ? 'import-seed' : 'import-privkey'
    // Handed straight to the wallet frame, which checks it (real BIP-39
    // checksum, same m/44'/60'/0'/0/0 path as always) and keeps it. The
    // input is cleared at once so the secret doesn't linger in this page.
    let result: { address: string; signer: WalletAccount } | null = null
    try {
      const signer = await importWallet(walletSource, secret)
      result = { address: signer.address, signer }
      setInput('')
    } catch (e) {
      setError(e instanceof WalletFrameError && e.code === 'invalid' ? e.message : 'Could not import wallet. Check your input.')
      setLoading(false); return
    } finally { secret = '' }

    // Only checked when an existing wallet is actually present on this
    // account - see the state comment above for why this never affects a
    // fresh signup.
    if (existingWalletAddress && result.address.toLowerCase() !== existingWalletAddress.toLowerCase()) {
      setMismatch({ result, walletSource })
      setLoading(false)
      return
    }

    // Account-type rules - for a sign-in / sign-up with this wallet, not for
    // restoring the key of an account this device is already signed in to.
    if (!existingWalletAddress) {
      const found = await lookupAccountByWallet(result.address)
      if (found.kind === 'error') { setError("Couldn't reach MeshPort. Please try again."); setLoading(false); return }
      const decision = decideAccountAccess(getChosenKind(), foundAccountOf(found.user), getAuthMode())
      if (decision.kind !== 'allow') { setBlocked({ decision, result, walletSource }); setLoading(false); return }
    }

    await finishImport(result, walletSource)
  }

  // The actual "commit" step - unchanged from what handleImport always did,
  // just factored out so it can run either immediately (no existing wallet,
  // or the imported address already matches it) or after explicit
  // confirmation from the mismatch warning below.
  const finishImport = async (result: { address: string; signer: WalletAccount }, walletSource: 'import-seed' | 'import-privkey') => {
    setLoading(true)
    // If no authenticated user yet (self-custody flow from LoginPage), create a local user
    // so isAuthenticated=true and AuthGuard lets them into the app
    if (!isAuthenticated || !user) {
      setLoginType('wallet')
      setUser(makeUser('usr_' + Date.now(), ''))
    }
    // This is the real fix for chats/contacts/rewards not working specifically
    // after importing (both seed-phrase and private-key): setUser() above
    // fires ensureAnonSession() as a fire-and-forget .then() chain - nothing
    // actually waits for the anonymous sign-in's real network round-trip to
    // finish. The create-wallet flow gets away with the same fire-and-forget
    // call because there's a mnemonic-backup + confirm-word screen between
    // here and reaching any page that needs a working session. This flow has
    // no equivalent delay - it navigates to claim-username and then into the
    // main app almost immediately after this point - so it was a genuine,
    // reproducible race: chat/contacts/rewards writes were firing with no
    // established session yet, silently falling back to the bare anon key
    // (see authHeaders()), which RLS correctly refuses for anything actually
    // scoped to a specific user.
    try { await ensureAnonSession() } catch (e) { console.warn('[Wallet] ensureAnonSession failed:', e) }
    setWallet(result.address, result.signer, walletSource)
    setBalance(0)
        // Use RAW passcode from the in-memory stash
    const { getPendingRawPasscode: getPendingRawPasscodeImport } = await import('@/lib/restoreWallet')
    const rawPasscodeImport = getPendingRawPasscodeImport()
    if (rawPasscodeImport) {
      try {
        // Local device storage only (the wallet frame's origin) - no
        // server-side copy, ever, of the private key or (for seed imports)
        // the phrase. Private-key-only imports have no phrase at all, so this
        // local copy - and whatever the user has independently saved of
        // their own key - is the *only* thing standing between them and
        // permanent loss if this device's storage is ever cleared.
        await setWalletPasscode(result.address, rawPasscodeImport)
        // Imported → the owner already holds the phrase / key they typed in.
        await markWalletBackedUp(result.address)
      } catch {}
      finally { const { clearRawPasscode } = await import('@/lib/restoreWallet'); clearRawPasscode() }
    }
    // Navigate BEFORE setLoading(false) so guard doesn't fire
    navigate('/auth/claim-username', { replace: true })
    setLoading(false)
    showToastMessage('Wallet imported!', 'success')
  }

  if (blocked) {
    const { decision } = blocked
    return (
      <AccountRuleNotice
        decision={decision}
        via="wallet"
        busy={loading}
        onContinue={() => {
          if (decision.kind === 'no_account') {
            // Back to the first screen, on Create account.
            setAuthIntent('create', null)
            navigate('/auth', { replace: true })
            return
          }
          // The wallet's real account type, on the Log in path.
          setAuthIntent('login', decision.existing)
          void finishImport(blocked.result, blocked.walletSource)
        }}
        onBack={() => { discardImport(blocked.result); setBlocked(null); setInput('') }}
      />
    )
  }

  if (mismatch) {
    return (
      <div className="flex flex-col h-full bg-bg px-6 py-12 overflow-y-auto">
        <div className="space-y-5">
          <div>
            <h2 className="text-2xl font-bold text-text-primary">This doesn't match your current wallet</h2>
            <p className="text-text-secondary mt-1 text-sm">
              Your MeshPort account is currently using a different wallet address than what you just entered.
            </p>
          </div>
          <div className="p-3 bg-warning/10 border border-warning/30 rounded-2xl space-y-2">
            <p className="text-sm text-warning flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>If you meant to recover your <strong>existing</strong> MeshPort wallet, double-check you pasted
              the right phrase/key - this looks like a <strong>different</strong> wallet (e.g. a personal
              MetaMask or OKX one), not the one MeshPort originally gave you.</span>
            </p>
            <p className="text-xs text-text-secondary font-mono break-all">Current: {existingWalletAddress}</p>
            <p className="text-xs text-text-secondary font-mono break-all">Importing: {mismatch.result.address}</p>
          </div>
          {isSocialLogin ? (
            <p className="text-sm text-text-secondary" role="note">
              This login already has a MeshPort account, so it can't be switched to a different wallet.
              Log in with this login to use your existing account, or use a different login for this wallet.
            </p>
          ) : (
            <p className="text-sm text-text-secondary">
              Switching will move you to this different wallet inside MeshPort. Your existing wallet isn't deleted -
              it's just no longer the one this account uses.
            </p>
          )}
          <div className="flex flex-col gap-2">
            <button
              onClick={() => { discardImport(mismatch.result); setMismatch(null) }}
              className="w-full py-3 bg-brand rounded-2xl text-sm font-bold text-white"
            >
              Cancel - check my input again
            </button>
            {!isSocialLogin && (
              <button
                onClick={() => finishImport(mismatch.result, mismatch.walletSource)}
                className="w-full py-3 bg-surface border border-border rounded-2xl text-sm font-medium text-text-secondary"
              >
                Yes, switch to this wallet anyway
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-bg px-6 py-12 overflow-y-auto">
      <button onClick={() => navigate(-1)} className="back-btn" style={{marginBottom:14}}><ArrowLeft className="w-5 h-5 text-text-primary" /></button>
      <div className="space-y-5">
        <div><h2 className="text-2xl font-bold text-text-primary">Import Wallet</h2><p className="text-text-secondary mt-1">Works with MetaMask, Trust, OKX, Coinbase</p></div>
        <div className="flex bg-surface rounded-2xl p-1 border border-border">
          {(['mnemonic', 'privatekey'] as const).map(m => (
            <button key={m} onClick={() => { setMethod(m); setInput(''); setError('') }}
              className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors flex items-center justify-center gap-1.5 ${method === m ? 'bg-brand text-white' : 'text-text-secondary'}`}>
              {m === 'mnemonic' ? <FileText className="w-3.5 h-3.5" /> : <KeyRound className="w-3.5 h-3.5" />}
              {m === 'mnemonic' ? 'Seed Phrase' : 'Private Key'}
            </button>
          ))}
        </div>
        <div className="p-3 bg-warning/10 border border-warning/30 rounded-2xl flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
          <p className="text-sm text-warning">Never share your {method === 'mnemonic' ? 'seed phrase' : 'private key'} with anyone.</p>
        </div>
        {method === 'mnemonic' ? (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm font-medium text-text-secondary">Recovery Phrase</label>
              {wordCount > 0 && <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${[12,15,18,21,24].includes(wordCount) ? 'bg-success/20 text-success' : 'bg-warning/20 text-warning'}`}>{wordCount} words</span>}
            </div>
            <textarea value={input} onChange={e => { setInput(e.target.value); setError('') }}
              placeholder="word1 word2 word3 ... word12" rows={4}
              className="w-full bg-surface border border-border rounded-2xl px-4 py-3 text-text-primary placeholder-gray-600 focus:outline-none focus:border-brand resize-none text-sm" />
          </div>
        ) : (
          <Input label="Private Key" type={showKey ? 'text' : 'password'} placeholder="0x..."
            value={input} onChange={e => { setInput(e.target.value); setError('') }}
            rightIcon={<button type="button" onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}</button>} />
        )}
        {error && <div role="alert" className="flex items-start gap-2 p-3 bg-danger/10 border border-danger/30 rounded-2xl"><AlertCircle className="w-4 h-4 text-danger mt-0.5" /><p className="text-sm text-danger">{error}</p></div>}
        <Button fullWidth loading={loading} onClick={handleImport} disabled={!input.trim()}>Import Wallet</Button>
      </div>
    </div>
  )
}

// Same list as the merchant application, so it can be prefilled from here.

export function ClaimUsernamePage() {
  const navigate = useNavigate()
  const setUsername = useAuthStore(s => s.setUsername)
  const setUser = useAuthStore(s => s.setUser)
  const user = useAuthStore(s => s.user)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const loginType = useAuthStore(s => s.loginType)
  const username = useAuthStore(s => s.username)
  const { showToastMessage } = useUIStore()
  const [handle, setHandle] = useState('')
  // Business sign-up: the username is the store's handle (sharmachai.arc),
  // plus a store name customers see.
  const signupKind = getSignupKind() ?? 'personal'
  const isBusiness = signupKind === 'business'
  const [status, setStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle')
  const [statusMsg, setStatusMsg] = useState('')
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(true)
  const [noAccount, setNoAccount] = useState(false)
  const logout = useAuthStore(s => s.logout)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Focused without scrolling (the page is still sliding in - see useAutoFocus).
  const handleRef = useRef<HTMLInputElement>(null)
  useAutoFocus(handleRef, !checking)

  // ── Check if wallet already has a registered profile ──────────────────────
  useEffect(() => {
    if (username) { navigate('/', { replace: true }); return }
    if (!walletAddress) { setChecking(false); return }
    getUserByWalletAddress(walletAddress).then(existing => {
      if (existing?.username) {
        // Wallet already registered - restore the REAL id along with the
        // username, not just the username. At this point (before
        // handleClaim ever runs) user.id is still the temporary
        // usr_<timestamp> placeholder - setUsername alone only sets the
        // display username field, never touches id. Without this, someone
        // re-importing a wallet they'd already registered on another
        // device (or after clearing local data) would see their correct
        // username show up, while every subsequent query for their
        // contacts/conversations/activity/rewards silently used the wrong
        // id and came back empty - a "successful" login into an account
        // that looks right but has none of their real data.
        //
        // BUG FIX (2026-09-03): this used to stop at id/username/
        // walletAddress and never carried over display_name/avatar_url,
        // even though `existing` already has both from the exact same
        // query - GoogleAuthPage's equivalent restore (a few hundred lines
        // up in this same file) does carry these over for social-auto
        // accounts; this path just never matched it. A re-imported wallet
        // with a previously-set profile picture and display name was
        // silently reverting to blank/default on every fresh device or
        // reinstall, even though the real values were one field away.
        setUser(mergeExistingWalletProfile(user, walletAddress, existing))
        setUsername(existing.username)
        clearAuthIntent()
        navigate(getAndClearReturnTo() || '/', { replace: true })
      } else {
        // Only Create account makes a new account - a Log in that got this
        // far without one (e.g. a typed URL) is stopped here too.
        if (getAuthMode() === 'login') setNoAccount(true)
        setChecking(false)
      }
    }).catch(() => setChecking(false))
  }, [walletAddress])

  // While checking whether this wallet already has a username, show a
  // real loading state instead of nothing. Returning null here used to be
  // fine for the fast path (an existing profile redirects away almost
  // instantly), but it's also the path a BRAND-NEW wallet takes - no
  // existing profile means this same blank screen sits through the full
  // getUserByWalletAddress round trip before the claim form ever appears,
  // which is exactly what reads as "the claim page shows up late" right
  // after creating a wallet.
  if (checking) return <LoadingDots />

  if (noAccount) {
    const startOver = (mode: AuthMode) => { logout(); setAuthIntent(mode, null); navigate('/auth', { replace: true }) }
    return (
      <AccountRuleNotice decision={{ kind: 'no_account' }} via={loginType === 'social' ? 'login' : 'wallet'}
        onContinue={() => startOver('create')} onBack={() => startOver('login')} />
    )
  }

  // ── Route guard ────────────────────────────────────────────────────────────
  if (username) return <Navigate to="/" replace />

  const handleChange = (value: string) => {
    const cleaned = value.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20)
    setHandle(cleaned); setStatus('idle'); setStatusMsg('')
    if (!cleaned) return
    if (cleaned.length < 3) { setStatus('invalid'); setStatusMsg('Minimum 3 characters'); return }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setStatus('checking')
    debounceRef.current = setTimeout(async () => {
      const taken = await isUsernameTakenDb(cleaned)
      if (taken) { setStatus('taken'); setStatusMsg(cleaned + '.arc is already taken ✗') }
      else { setStatus('available'); setStatusMsg(cleaned + '.arc is available ✓') }
    }, 500)
  }

  const handleClaim = async () => {
    if (status !== 'available' || !walletAddress || !handle) return
    setLoading(true)

    // Final availability check against Supabase
    const taken = await isUsernameTakenDb(handle)
    if (taken) { setStatus('taken'); setStatusMsg(handle + '.arc just taken ✗'); setLoading(false); return }

    // ALL user types save to Supabase users table.
    // Wallet-only users get a stable UUID derived from their wallet address.
    // The users_insert RLS policy is set to "with check (true)" so no auth session needed.
    const stableId = user?.id && !user.id.startsWith('usr_')
      ? user.id
      : await deriveWalletUserId(walletAddress)

    const { error } = await upsertUserProfile({
      id: stableId,
      email: user?.email || '',
      username: handle,
      displayName: user?.displayName || handle,
      walletAddress,
      loginType: loginType === 'social' ? 'social' : 'wallet',
    })

    if (error) {
      console.error('[Claim] Supabase save error:', error)
      showToastMessage(/already has a MeshPort account/i.test(String(error))
        ? 'This login already has a MeshPort account. Log in with it instead, or use a different login.'
        : 'Error saving username: ' + error, 'error')
      setLoading(false)
      return
    }


    // Update local state - use the stable ID so it's consistent on future logins
    if (user?.id.startsWith('usr_')) {
      setUser({ ...user, id: stableId, username: handle + '.arc', walletAddress })
    } else if (user) {
      setUser({ ...user, username: handle + '.arc', walletAddress })
    }
    // Business: mark the new account as a business (only allowed right after
    // sign-up; the database refuses merchant applications from personal
    // accounts). The business can use the app at once; Home then asks it to
    // complete the application (reason) for MeshPort's review.
    if (isBusiness) {
      try {
        const { data: isBiz } = await supabase.rpc('start_business_account')
        if (!isBiz) throw new Error('Could not set up the business account')
      } catch (e) {
        console.warn('[Claim] business account:', e instanceof Error ? e.message : e)
      }
    }

    // Register the name on Arc (signed by this wallet, gas paid by MeshPort)
    // in the background. Sign-up used to wait here for the on-chain receipt -
    // up to 35s on the claim screen before the app opened. A failure is
    // retried by the server (name-register sync) and from Home.
    void registerNameOnchain({ walletAddress, name: handle, kind: signupKind, displayName: '' })
      .then(r => { if (r.status === 'registered') showToastMessage(`${handle}.arc is registered on Arc 🎉`, 'success') })
      .catch(() => {})
    clearAuthIntent()
    void refreshMerchant()

    setUsername(handle)
    setLoading(false)
    showToastMessage(`${handle}.arc is yours!`, 'success')
    // replace: true removes /auth/claim-username from history - back button skips it
    navigate(getAndClearReturnTo() || '/', { replace: true })
  }

  const statusColors = { idle: '', checking: 'text-text-secondary', available: 'text-success', taken: 'text-danger', invalid: 'text-warning' }
  const icons = { idle: null, checking: <Loader2 className="w-4 h-4 animate-spin text-text-secondary" />, available: <CheckCircle className="w-4 h-4 text-success" />, taken: <XCircle className="w-4 h-4 text-danger" />, invalid: <AlertCircle className="w-4 h-4 text-warning" /> }

  return (
    // Scrolls: with the phone keyboard up, the Claim button sits below the
    // keys - it must be reachable without closing the keyboard first.
    <div className="h-full overflow-y-auto bg-bg">
    <div className="min-h-full flex flex-col px-6 py-12">
      <div className="flex-1 flex flex-col justify-center space-y-8 max-w-sm mx-auto w-full">
        <div className="text-center">
          <div className="w-16 h-16 bg-brand/20 rounded-3xl flex items-center justify-center mx-auto mb-4">
            <AtSign className="w-8 h-8 text-brand-text" />
          </div>
          <h2 className="text-2xl font-bold text-text-primary">{isBusiness ? 'Claim your business username' : 'Claim Your Username'}</h2>
          <p className="text-text-secondary mt-2">{isBusiness ? 'Your business on MeshPort. Add your shops after approval.' : 'Your permanent MeshPort identity'}</p>
          {!walletAddress && (
            <div className="mt-3 p-3 bg-danger/10 border border-danger/30 rounded-2xl flex items-start gap-2 text-left">
              <AlertTriangle className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-danger">No wallet found. Please set up a wallet first.</p>
                <button onClick={() => navigate('/auth/wallet-setup', { replace: true })} className="text-xs text-brand-text mt-1 underline">Set up wallet →</button>
              </div>
            </div>
          )}
        </div>
        <div className="space-y-4">
          {isBusiness && (
            <label htmlFor="store-handle" className="block text-sm font-semibold text-text-primary">Business username</label>
          )}
          <div>
            <div className="flex items-center bg-surface border border-border rounded-2xl focus-within:border-brand transition-colors">
              <input id="store-handle" ref={handleRef} value={handle} onChange={e => handleChange(e.target.value)}
                placeholder="yourname" maxLength={20}
                className="flex-1 bg-transparent pl-4 pr-2 py-3.5 text-text-primary placeholder-gray-600 focus:outline-none text-base"
                autoCapitalize="none" autoCorrect="off" />
              <span className="text-text-secondary font-semibold pr-2">.arc</span>
              <div className="pr-3 w-8 flex justify-center">{icons[status]}</div>
            </div>
            {/* Fixed-height line: a message appearing / changing as you type
                never moves the page. */}
            <div className="h-5 mt-2">
              <AnimatePresence mode="popLayout" initial={false}>
                {statusMsg && (
                  <motion.p key={statusMsg} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className={`text-sm text-center font-medium ${statusColors[status]}`}>{statusMsg}</motion.p>
                )}
              </AnimatePresence>
            </div>
          </div>
          <div className="text-xs text-text-muted space-y-1 px-1">
            <p>• 3–20 characters</p><p>• Letters a-z, numbers 0-9, underscore _</p><p>• Cannot be changed later · registered on Arc, free</p>
          </div>
          <Button fullWidth loading={loading} disabled={status !== 'available' || !walletAddress} onClick={handleClaim}>
            {loading ? 'Saving...' : status === 'available' ? `Claim ${handle}.arc` : isBusiness ? 'Claim business username' : 'Claim Username'}
          </Button>
        </div>
      </div>
    </div>
    </div>
  )
}

function GoogleIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  )
}
