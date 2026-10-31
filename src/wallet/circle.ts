// src/wallet/circle.ts
//
// The app side of Circle user-controlled wallets (docs/CIRCLE_WALLETS.md).
//
// Sign-in: MeshPort's "Continue with Google" opens Google once and the answer
// signs the user in to both MeshPort (Supabase, signInWithIdToken) and their
// Circle wallet (Circle's Web SDK). MeshPort builds the Google request itself
// so the one-time nonce serves both: Google gets sha256(raw), Supabase gets
// raw (it checks the hash), and Circle's SDK finds the hashed value where it
// keeps its own (localStorage 'state' / 'nonce' / 'socialLoginProvider',
// @circle-fin/w3s-pw-web-sdk 1.1.11 - pinned).
//
// Signing: circleAccount() is a WalletAccount like the frame's - every
// signature is a Circle challenge run headless in Circle's SDK (Confirmation
// UIs are off in Circle Console; the app's passcode / biometric is the
// approval), and the app broadcasts signed transactions itself through its
// usual relay.
//
// The Circle session (userToken + encryptionKey + refreshToken) is kept per
// MeshPort account in this browser and refreshed BEFORE it expires: Circle's
// userToken lasts 60 minutes, and one that expires unrefreshed logs the user
// out (Circle docs) - refreshing only after a call failed meant a Google
// sign-in again after every idle hour.
//
// Readiness (like Privy's, lib/walletReadiness): a Circle signer is only
// "ready" once its session is valid, the backend has confirmed the wallet,
// and Circle's SDK and frame are loaded (warmCircleSigner) - so the first
// payment doesn't pay for any of that.
//
// OFF for new sign-ins: MeshPort's Google sign-in goes through Circle only
// with VITE_CIRCLE_WALLETS_ENABLED=true (new wallets are Privy). Accounts
// whose wallet already is a Circle wallet keep working either way.

import { toAccount } from 'viem/accounts'
import { bytesToHex, getTypesForEIP712Domain, type Hex, type TypedDataDefinition } from 'viem'
import { authApiHeaders, supabase } from '@/lib/supabase'
import { plainTransaction, type WalletAccount } from './account'
import type { W3SSdk } from '@circle-fin/w3s-pw-web-sdk'

const APP_ID = (import.meta.env.VITE_CIRCLE_APP_ID as string | undefined)?.trim() ?? ''
const GOOGLE_CLIENT_ID = (import.meta.env.VITE_CIRCLE_GOOGLE_CLIENT_ID as string | undefined)?.trim() ?? ''
export const CIRCLE_LOGIN_PATH = '/wallet/circle-login'

const SESSION_KEY = (uid: string) => `mp.circle.session.${uid}`
const DEVICE_KEY = 'mp.circle.deviceId'
const PENDING_KEY = 'mp.circle.pendingLogin'
const PENDING_MAX_AGE_MS = 15 * 60_000

const SIGN_IN_ENABLED = (import.meta.env.VITE_CIRCLE_WALLETS_ENABLED as string | undefined)?.trim() === 'true'

export const circleConfigured = (): boolean => !!APP_ID
/** Circle's Google sign-in can run (an existing Circle wallet signing in again on this device). */
export const circleGoogleConfigured = (): boolean => !!APP_ID && !!GOOGLE_CLIENT_ID
/** MeshPort's own Google sign-in goes through Circle - off unless explicitly enabled. */
export const circleSignInForNewAccounts = (): boolean => SIGN_IN_ENABLED && circleGoogleConfigured()

/** `obtainedAt`: when Circle issued this userToken (sessions saved before it was kept have none). */
export interface CircleSession { userToken: string; encryptionKey: string; refreshToken?: string; obtainedAt?: number }

// Circle: "a 60-minute session token". Refreshed once less than this is left.
export const CIRCLE_SESSION_MS = 60 * 60_000
export const CIRCLE_REFRESH_AHEAD_MS = 10 * 60_000
const API_TIMEOUT_MS = 20_000

/** When this session's userToken expires: its JWT `exp` if it has one, else 60 min after it was issued. */
export function circleSessionExpiry(s: CircleSession): number | null {
  const parts = s.userToken.split('.')
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: unknown }
      if (typeof payload.exp === 'number') return payload.exp * 1000
    } catch { /* not a JWT */ }
  }
  return s.obtainedAt ? s.obtainedAt + CIRCLE_SESSION_MS : null
}
const expired = (s: CircleSession, now = Date.now()) => { const e = circleSessionExpiry(s); return e !== null && now >= e }
/** Unknown expiry (an older saved session) counts as due: one refresh settles it. */
const dueForRefresh = (s: CircleSession, now = Date.now()) => { const e = circleSessionExpiry(s); return e === null || e - now < CIRCLE_REFRESH_AHEAD_MS }

export class CircleError extends Error {
  constructor(public status: number, public code: string | null, message: string) { super(message) }
}

// ── storage (every access guarded: private windows / blocked storage) ───────

function read<T>(key: string): T | null {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as T : null } catch { return null }
}
function write(key: string, value: unknown): void {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage blocked */ }
}
function writeRaw(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* storage blocked */ }
}
function readRaw(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

export const loadCircleSession = (uid: string): CircleSession | null => read<CircleSession>(SESSION_KEY(uid))
export const saveCircleSession = (uid: string, s: CircleSession | null): void => write(SESSION_KEY(uid), s)

/** Who is signed in to MeshPort (Google / email, not an anonymous session). */
export async function meshportAccount(): Promise<{ uid: string; email: string | null; anonymous: boolean } | null> {
  const u = (await supabase.auth.getSession()).data.session?.user
  return u ? { uid: u.id, email: u.email ?? null, anonymous: u.is_anonymous === true } : null
}

// ── backend ─────────────────────────────────────────────────────────────────

export async function circleApi<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  let r: Response
  try {
    r = await fetch('/api/circle-wallet', {
      method: 'POST', headers: await authApiHeaders(),
      body: JSON.stringify({ action, ...body }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      // A hung request used to hold a payment screen with no end.
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    throw new CircleError(504, 'timeout', timedOut ? 'Your wallet did not answer - nothing was sent. Try again.' : 'Could not reach your wallet - check your connection and try again')
  }
  const j = await r.json().catch(() => null) as (T & { error?: string; code?: string }) | null
  if (!r.ok) throw new CircleError(r.status, j?.code ?? null, j?.error || `Wallet service error (${r.status})`)
  return j as T
}

/** A backend call that needs the Circle session: refreshed ahead of expiry, and once more if Circle still calls it expired. */
export async function circleCall<T>(uid: string, action: string, body: Record<string, unknown> = {}): Promise<T> {
  const s = await freshCircleSession(uid)
  try {
    return await circleApi<T>(action, { ...body, userToken: s.userToken })
  } catch (e) {
    if (!(e instanceof CircleError) || e.code !== 'session') throw e
    const fresh = await refreshSession(uid, s, false)
    return circleApi<T>(action, { ...body, userToken: fresh.userToken })
  }
}

const refreshing = new Map<string, Promise<CircleSession>>()

/**
 * The account's Circle session, refreshed first when less than
 * CIRCLE_REFRESH_AHEAD_MS is left (one refresh at a time per account).
 * A refresh that fails for a reason other than Circle refusing the session
 * (offline, a slow backend) keeps a still-valid session.
 */
export async function freshCircleSession(uid: string): Promise<CircleSession> {
  const s = loadCircleSession(uid)
  if (!s) throw new CircleError(401, 'session', 'Sign in to your Circle wallet')
  if (!dueForRefresh(s)) return s
  let p = refreshing.get(uid)
  if (!p) {
    p = refreshSession(uid, s, true).finally(() => refreshing.delete(uid))
    refreshing.set(uid, p)
  }
  try {
    return await p
  } catch (e) {
    if (e instanceof CircleError && e.code === 'session') throw e
    if (!expired(s)) return s
    throw new CircleError(401, 'session', 'Sign in to your Circle wallet again')
  }
}

/**
 * Exchanges the refresh token for a new session. Circle refusing it (or no
 * refresh token / device id) ends the session: the user signs in again. With
 * `ahead` (the token is still valid), any other failure keeps the session.
 */
async function refreshSession(uid: string, s: CircleSession, ahead: boolean): Promise<CircleSession> {
  const deviceId = read<string>(DEVICE_KEY)
  if (!s.refreshToken || !deviceId) {
    if (ahead && !expired(s)) throw new CircleError(503, 'refresh', 'Circle session could not be refreshed yet')
    endSession(uid); throw new CircleError(401, 'session', 'Sign in to your Circle wallet again')
  }
  try {
    const r = await circleApi<{ userToken: string; encryptionKey?: string; refreshToken?: string }>('refresh', { userToken: s.userToken, refreshToken: s.refreshToken, deviceId })
    const fresh: CircleSession = { userToken: r.userToken, encryptionKey: r.encryptionKey ?? s.encryptionKey, refreshToken: r.refreshToken ?? s.refreshToken, obtainedAt: Date.now() }
    saveCircleSession(uid, fresh)
    return fresh
  } catch (e) {
    const refused = e instanceof CircleError && e.code === 'session'
    if (ahead && !refused) throw e
    endSession(uid)
    throw refused ? e : new CircleError(401, 'session', 'Sign in to your Circle wallet again')
  }
}

function endSession(uid: string): void {
  saveCircleSession(uid, null)
  for (const k of [...readyAddresses.keys()]) if (readyAddresses.get(k) === uid) readyAddresses.delete(k)
  notifyReadiness()
}

// ── Circle's Web SDK (loaded only when needed) ──────────────────────────────

let sdkPromise: Promise<W3SSdk> | null = null
type LoginCallback = (error: unknown, result: unknown) => void
type LoginConfigs = { deviceToken: string; deviceEncryptionKey: string; otpToken?: string; email?: { email: string }; google?: { clientId: string; redirectUri: string; selectAccountPrompt?: boolean } }

/** The SDK, with these login settings. Constructing it also picks up a Google
 *  answer in the page address and sends it to Circle. */
function sdk(loginConfigs?: LoginConfigs, onLogin?: LoginCallback): Promise<W3SSdk> {
  const configs = { appSettings: { appId: APP_ID }, ...(loginConfigs ? { loginConfigs } : {}) }
  if (!sdkPromise) {
    sdkPromise = import('@circle-fin/w3s-pw-web-sdk').then(m => new m.W3SSdk(configs as never, onLogin as never))
    sdkPromise.catch(() => { sdkPromise = null })
    return sdkPromise
  }
  return sdkPromise.then(s => { s.updateConfigs(configs as never, onLogin as never); return s })
}

async function deviceId(): Promise<string> {
  const cached = read<string>(DEVICE_KEY)
  if (cached) return cached
  const id = await (await sdk()).getDeviceId()
  write(DEVICE_KEY, id)
  return id
}

/** Load Circle's SDK and this browser's device id ahead of a sign-in tap. */
export function warmCircle(): void {
  if (circleGoogleConfigured()) void deviceId().catch(() => {})
}

function loginResult(error: unknown, result: unknown): CircleSession {
  const r = result as { userToken?: string; encryptionKey?: string; refreshToken?: string } | undefined
  if (error || !r?.userToken || !r.encryptionKey) {
    const e = error as { code?: number; message?: string } | undefined
    const m = e?.message || 'Circle sign-in did not finish'
    throw new CircleError(401, 'login', e?.code ? `${m} (${e.code})` : m)
  }
  return { userToken: r.userToken, encryptionKey: r.encryptionKey, refreshToken: r.refreshToken, obtainedAt: Date.now() }
}

/** Link the Circle sign-in to this MeshPort account and keep the session. */
async function finishLogin(uid: string, s: CircleSession): Promise<void> {
  await circleApi('link', { userToken: s.userToken }) // refuses a Circle sign-in that belongs to another account
  saveCircleSession(uid, s)
}

// ── Google sign-in (MeshPort + Circle with one Google screen) ───────────────

type Pending = { meshport: boolean; uid?: string; rawNonce: string; deviceToken: string; deviceEncryptionKey: string; returnTo: string; at: number }

const randomHex = (bytes: number) => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes))).slice(2)
async function sha256Hex(s: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))).slice(2)
}
const googleRedirect = () => window.location.origin + CIRCLE_LOGIN_PATH

/**
 * Leave for Google. `meshport: true` - the MeshPort sign-in itself (login
 * screen): Google's answer signs in to MeshPort and Circle, then the app goes
 * on at /auth/google. `meshport: false` - a signed-in user's Circle wallet
 * only (its session ended), back to `returnTo`.
 */
export async function startGoogleSignIn(opts: { meshport: true } | { meshport: false; uid: string; returnTo: string }): Promise<void> {
  const id = await deviceId()
  const t = await circleApi<{ deviceToken: string; deviceEncryptionKey: string }>('social-device-token', { deviceId: id })
  const rawNonce = randomHex(32)
  const nonce = await sha256Hex(rawNonce)
  const state = crypto.randomUUID()
  // Where Circle's SDK looks for them when Google sends the user back - the
  // provider exactly as the SDK spells it ("Google"; anything else and it
  // never checks the sign-in with Circle).
  const { SocialLoginProvider } = await import('@circle-fin/w3s-pw-web-sdk/dist/src/types')
  writeRaw('socialLoginProvider', SocialLoginProvider.GOOGLE); writeRaw('state', state); writeRaw('nonce', nonce)
  write(PENDING_KEY, {
    meshport: opts.meshport, uid: opts.meshport === false ? opts.uid : undefined, rawNonce,
    deviceToken: t.deviceToken, deviceEncryptionKey: t.deviceEncryptionKey,
    returnTo: opts.meshport === false ? opts.returnTo : '/auth/google', at: Date.now(),
  } satisfies Pending)
  const q = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, redirect_uri: googleRedirect(),
    scope: 'openid https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
    state, response_type: 'id_token token', nonce, prompt: 'select_account',
  })
  window.location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${q}`)
}

/** Circle's SDK checks Google's answer (still in the page address) with Circle. */
function circleLogin(p: Pending): Promise<CircleSession> {
  return new Promise<CircleSession>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CircleError(504, 'login', 'Circle did not answer - try again')), 45_000)
    sdk({ deviceToken: p.deviceToken, deviceEncryptionKey: p.deviceEncryptionKey, google: { clientId: GOOGLE_CLIENT_ID, redirectUri: googleRedirect(), selectAccountPrompt: true } }, (error, result) => {
      clearTimeout(timer)
      try { resolve(loginResult(error, result)) } catch (e) { reject(e) }
    }).catch(e => { clearTimeout(timer); reject(e) })
  })
}

/**
 * On CIRCLE_LOGIN_PATH, where Google sends the user back. Signs in to
 * MeshPort first when it's the MeshPort sign-in (a Circle hiccup then doesn't
 * stop it - the wallet asks again later), then to Circle. Where to go next.
 */
/** Where the pending Google sign-in goes back to (for a "Back" after a failure). */
export function pendingSignInReturn(): string {
  const p = read<Pending>(PENDING_KEY)
  if (!p) return '/auth'
  return p.meshport ? '/auth' : p.returnTo.startsWith('/') && !p.returnTo.startsWith('//') ? p.returnTo : '/'
}

export async function finishGoogleSignIn(): Promise<{ returnTo: string; circleError?: string }> {
  const p = read<Pending>(PENDING_KEY)
  write(PENDING_KEY, null)
  const hash = new URLSearchParams(window.location.hash.slice(1))
  if (!p || Date.now() - p.at > PENDING_MAX_AGE_MS) throw new CircleError(400, 'login', 'That sign-in expired - start again')
  if (hash.get('error')) throw new CircleError(401, 'login', 'Google sign-in was cancelled')
  const idToken = hash.get('id_token')
  const accessToken = hash.get('access_token') ?? undefined
  if (!idToken || !hash.get('state') || hash.get('state') !== readRaw('state')) throw new CircleError(401, 'login', 'Google sign-in failed - start again')

  // Starts Circle's check now, while Google's answer is still in the address
  // (the SDK clears it).
  const circle = circleLogin(p)
  circle.catch(() => {})

  let uid = p.uid
  if (p.meshport) {
    const { data, error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: idToken, access_token: accessToken, nonce: p.rawNonce })
    if (error || !data.user) {
      console.error('[circle] MeshPort sign-in with the Google token failed:', error?.message)
      throw new CircleError(401, 'meshport-login', 'Google sign-in failed - try again')
    }
    uid = data.user.id
  } else {
    const account = await meshportAccount()
    if (account?.uid !== p.uid) throw new CircleError(401, 'login', 'You were signed out of MeshPort - sign in and start again')
  }

  const safeReturn = p.returnTo.startsWith('/') && !p.returnTo.startsWith('//') ? p.returnTo : '/'
  try {
    await finishLogin(uid!, await circle)
    return { returnTo: safeReturn }
  } catch (e) {
    // Saved to client_errors (no tokens in it) - a failed Circle sign-in
    // is otherwise only visible in the user's browser.
    void import('@/lib/errorReport').then(r => r.reportClientError('rejection', new Error(`[circle sign-in] ${e instanceof Error ? e.message : String(e)}`))).catch(() => {})
    if (!p.meshport) throw e
    console.warn('[circle] wallet sign-in failed; MeshPort sign-in continues', e)
    return { returnTo: safeReturn, circleError: e instanceof Error ? e.message : 'Circle sign-in failed' }
  }
}

// ── challenges, wallet, signer ──────────────────────────────────────────────

export interface ChallengeOutcome { status?: string; type?: string; signature?: Hex; signedTransaction?: Hex }

// Circle's SDK runs one challenge at a time: one frame, one callback - a
// second execute() replaces the first one's callback, which then never
// finishes (a payment screen waiting forever). Challenges queue here.
let challengeQueue: Promise<unknown> = Promise.resolve()
// A signature normally takes a few seconds; Circle's SDK's own 10 s guard
// stops working after its frame first answers (receivedResponseFromService
// is never reset), so this is the limit a stuck one is held to.
const CHALLENGE_TIMEOUT_MS = 30_000
// Circle's SDK error codes that mean the session is gone, not "declined":
// userTokenNotFound, userTokenExpired, invalidUserToken (SDK types.d.ts).
const SESSION_ERRORS = new Set([155103, 155104, 155105])

/** Run a challenge in Circle's SDK (no screen while Confirmation UIs are off), one at a time. */
export function executeChallenge(uid: string, challengeId: string): Promise<ChallengeOutcome> {
  const run = () => runChallenge(uid, challengeId)
  const next = challengeQueue.then(run, run)
  challengeQueue = next.catch(() => {})
  return next
}

async function runChallenge(uid: string, challengeId: string): Promise<ChallengeOutcome> {
  const s = await freshCircleSession(uid)
  const w = await sdk()
  w.setAuthentication({ userToken: s.userToken, encryptionKey: s.encryptionKey })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CircleError(504, 'challenge', 'Circle did not answer - try again')), CHALLENGE_TIMEOUT_MS)
    w.execute(challengeId, (error, result) => {
      clearTimeout(timer)
      if (error) {
        const e = error as { code?: number; message?: string }
        reject(new CircleError(400, e.code !== undefined && SESSION_ERRORS.has(e.code) ? 'session' : 'challenge', e.message || 'Not approved'))
        return
      }
      const r = result as { status?: string; type?: string; data?: { signature?: Hex; signedTransaction?: Hex } } | undefined
      resolve({ status: r?.status, type: r?.type, signature: r?.data?.signature, signedTransaction: r?.data?.signedTransaction })
    })
  })
}

export type CircleAccount = WalletAccount & { readonly circleWallet: true }
export const isCircleAccount = (v: unknown): v is CircleAccount => !!v && typeof v === 'object' && (v as { circleWallet?: unknown }).circleWallet === true

const accounts = new Map<string, CircleAccount>()

/** The Circle wallet as the rest of the app sees a wallet: an address plus "please sign". */
export function circleAccount(address: string, uid: string): CircleAccount {
  const key = `${uid}:${address.toLowerCase()}`
  const hit = accounts.get(key)
  if (hit) return hit
  async function sign(action: string, body: Record<string, unknown>): Promise<ChallengeOutcome> {
    for (let attempt = 0; ; attempt++) {
      const { challengeId } = await circleCall<{ challengeId: string }>(uid, action, body)
      try {
        const out = await executeChallenge(uid, challengeId)
        readyAddresses.set(address.toLowerCase(), uid) // it signed: as ready as the warm-up makes it
        notifyReadiness()
        return out
      } catch (e) {
        // The session ended between creating the challenge and running it:
        // refresh once and sign again with a new challenge (nothing was signed).
        const s = loadCircleSession(uid)
        if (attempt > 0 || !(e instanceof CircleError) || e.code !== 'session' || !s) throw e
        await refreshSession(uid, s, false)
      }
    }
  }
  const base = toAccount({
    address: address as Hex,
    async signMessage({ message }) {
      const body = typeof message === 'string' ? { message }
        : { message: typeof message.raw === 'string' ? message.raw : bytesToHex(message.raw), encodedByHex: true }
      const r = await sign('sign-message', body)
      if (!r.signature) throw new CircleError(502, 'challenge', 'Circle returned no signature')
      return r.signature
    },
    async signTransaction(transaction) {
      const r = await sign('sign-transaction', { transaction: plainTransaction(transaction) })
      if (!r.signedTransaction) throw new CircleError(502, 'challenge', 'Circle returned no signed transaction')
      return r.signedTransaction
    },
    async signTypedData(typedData) {
      const { domain, types, primaryType, message } = typedData as TypedDataDefinition
      const full = { EIP712Domain: getTypesForEIP712Domain({ domain }), ...(types as Record<string, unknown>) }
      const r = await sign('sign-typed', { typedData: { domain, types: full, primaryType, message } })
      if (!r.signature) throw new CircleError(502, 'challenge', 'Circle returned no signature')
      return r.signature
    },
  })
  const account = Object.assign(base, { meshportWallet: true as const, circleWallet: true as const }) as CircleAccount
  accounts.set(key, account)
  return account
}

/**
 * The signed-in account's Circle signer for `address`, if this browser has a
 * Circle session that is still valid (or can be refreshed). Its warm-up starts
 * at once; readiness reports "ready" only when that has finished.
 */
export async function restoreCircleAccount(address: string): Promise<CircleAccount | null> {
  const a = await meshportAccount()
  if (!a || a.anonymous || !loadCircleSession(a.uid)) return null
  try { await freshCircleSession(a.uid) } catch { return null }
  const account = circleAccount(address, a.uid)
  void warmCircleSigner(address)
  return account
}

// ── readiness and warm-up ───────────────────────────────────────────────────
// address (lower case) → uid, once warmCircleSigner (or a real signature)
// proved this browser can sign for it now.
const readyAddresses = new Map<string, string>()
const warming = new Map<string, Promise<boolean>>()

function notifyReadiness(): void {
  void import('@/lib/walletReadiness').then(m => m.recompute()).catch(() => {})
}

/** True once this address's Circle session is valid, confirmed by the backend, and Circle's SDK is loaded. */
export function circleSignerReady(address: string): boolean {
  const uid = readyAddresses.get(address.toLowerCase())
  if (!uid) return false
  const s = loadCircleSession(uid)
  return !!s && !expired(s)
}
void import('@/lib/walletReadiness').then(m => m.setCircleReadyProbe(circleSignerReady)).catch(() => {})

/** Opens the connection to Circle's frame early (its page loads for every signature). */
function preconnectCircle(): void {
  try {
    if (typeof document === 'undefined' || document.querySelector('link[data-circle-preconnect]')) return
    const l = document.createElement('link')
    l.rel = 'preconnect'; l.href = 'https://pw-auth.circle.com'; l.crossOrigin = ''
    l.setAttribute('data-circle-preconnect', '')
    document.head.appendChild(l)
  } catch { /* no DOM */ }
}

/**
 * Gets a Circle signer ready before the first payment (like Privy's
 * warm-up): refreshes the session if it's due, asks the backend for the
 * wallet (checks the session and the link, and wakes the wallet service),
 * and loads Circle's SDK and frame. Ready only if all of it works.
 */
export function warmCircleSigner(address: string): Promise<boolean> {
  const a = address.toLowerCase()
  const running = warming.get(a)
  if (running) return running
  preconnectCircle()
  const p = (async () => {
    const acct = await meshportAccount()
    if (!acct || acct.anonymous || !loadCircleSession(acct.uid)) return false
    const [w] = await Promise.all([
      circleCall<{ address: string }>(acct.uid, 'wallet'),
      deviceId(), // loads the SDK and Circle's frame
    ])
    if (w.address.toLowerCase() !== a) return false
    readyAddresses.set(a, acct.uid)
    keepSessionFresh()
    return true
  })().catch(() => false).finally(() => { warming.delete(a); notifyReadiness() })
  warming.set(a, p)
  return p
}

let keeping = false
/** While the app is open: refresh each ready session before it expires (and on return to the app). */
function keepSessionFresh(): void {
  if (keeping || typeof window === 'undefined') return
  keeping = true
  const tick = () => {
    for (const uid of new Set(readyAddresses.values())) void freshCircleSession(uid).catch(() => notifyReadiness())
  }
  setInterval(tick, 5 * 60_000)
  try { document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick() }) } catch { /* no DOM */ }
}

/** At sign-in: the Circle signer when `address` (the account's wallet) is this account's Circle wallet. */
export async function circleSignerFor(uid: string, address: string): Promise<CircleAccount | null> {
  if (!circleConfigured() || !loadCircleSession(uid)) return null
  try {
    const w = await circleCall<{ address: string }>(uid, 'wallet')
    if (w.address.toLowerCase() !== address.toLowerCase()) return null
    void warmCircleSigner(w.address)
    return circleAccount(w.address, uid)
  } catch { return null }
}

export function signOutCircle(uid: string): void { endSession(uid) }
