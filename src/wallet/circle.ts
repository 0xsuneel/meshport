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
// MeshPort account in this browser and refreshed once when it expires.

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

export const circleConfigured = (): boolean => !!APP_ID
export const circleGoogleConfigured = (): boolean => !!APP_ID && !!GOOGLE_CLIENT_ID

export interface CircleSession { userToken: string; encryptionKey: string; refreshToken?: string }

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
  const r = await fetch('/api/circle-wallet', {
    method: 'POST', headers: await authApiHeaders(),
    body: JSON.stringify({ action, ...body }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  })
  const j = await r.json().catch(() => null) as (T & { error?: string; code?: string }) | null
  if (!r.ok) throw new CircleError(r.status, j?.code ?? null, j?.error || `Wallet service error (${r.status})`)
  return j as T
}

/** A backend call that needs the Circle session: refreshed once if it expired. */
export async function circleCall<T>(uid: string, action: string, body: Record<string, unknown> = {}): Promise<T> {
  const s = loadCircleSession(uid)
  if (!s) throw new CircleError(401, 'session', 'Sign in to your Circle wallet')
  try {
    return await circleApi<T>(action, { ...body, userToken: s.userToken })
  } catch (e) {
    if (!(e instanceof CircleError) || e.code !== 'session') throw e
    const fresh = await refreshSession(uid, s)
    return circleApi<T>(action, { ...body, userToken: fresh.userToken })
  }
}

async function refreshSession(uid: string, s: CircleSession): Promise<CircleSession> {
  const deviceId = read<string>(DEVICE_KEY)
  if (!s.refreshToken || !deviceId) { saveCircleSession(uid, null); throw new CircleError(401, 'session', 'Sign in to your Circle wallet again') }
  try {
    const r = await circleApi<{ userToken: string; encryptionKey?: string; refreshToken?: string }>('refresh', { userToken: s.userToken, refreshToken: s.refreshToken, deviceId })
    const fresh = { userToken: r.userToken, encryptionKey: r.encryptionKey ?? s.encryptionKey, refreshToken: r.refreshToken ?? s.refreshToken }
    saveCircleSession(uid, fresh)
    return fresh
  } catch (e) {
    saveCircleSession(uid, null)
    throw e instanceof CircleError && e.code === 'session' ? e : new CircleError(401, 'session', 'Sign in to your Circle wallet again')
  }
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
  return { userToken: r.userToken, encryptionKey: r.encryptionKey, refreshToken: r.refreshToken }
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

/** Sign in with a code Circle emails to this MeshPort account's address
 *  (the backend picks the address). Circle's screen asks for the code. */
export async function emailLogin(uid: string, email: string): Promise<void> {
  const id = await deviceId()
  const t = await circleApi<{ deviceToken: string; deviceEncryptionKey: string; otpToken: string }>('email-device-token', { deviceId: id })
  const session = await new Promise<CircleSession>((resolve, reject) => {
    sdk({ deviceToken: t.deviceToken, deviceEncryptionKey: t.deviceEncryptionKey, otpToken: t.otpToken, email: { email } }, (error, result) => {
      try { resolve(loginResult(error, result)) } catch (e) { reject(e) }
    }).then(s => s.verifyOtp()).catch(reject)
  })
  await finishLogin(uid, session)
}

// ── challenges, wallet, signer ──────────────────────────────────────────────

export interface ChallengeOutcome { status?: string; type?: string; signature?: Hex; signedTransaction?: Hex }

/** Run a challenge in Circle's SDK (no screen while Confirmation UIs are off). */
export async function executeChallenge(uid: string, challengeId: string): Promise<ChallengeOutcome> {
  const s = loadCircleSession(uid)
  if (!s) throw new CircleError(401, 'session', 'Sign in to your Circle wallet')
  const w = await sdk()
  w.setAuthentication({ userToken: s.userToken, encryptionKey: s.encryptionKey })
  return new Promise((resolve, reject) => {
    w.execute(challengeId, (error, result) => {
      if (error) {
        const e = error as { code?: number; message?: string }
        reject(new CircleError(400, e.code === 155104 ? 'session' : 'challenge', e.message || 'Not approved'))
        return
      }
      const r = result as { status?: string; type?: string; data?: { signature?: Hex; signedTransaction?: Hex } } | undefined
      resolve({ status: r?.status, type: r?.type, signature: r?.data?.signature, signedTransaction: r?.data?.signedTransaction })
    })
  })
}

/** The account's Circle wallet address, creating the wallet first if needed. */
export async function ensureCircleWallet(uid: string): Promise<Hex> {
  const r = await circleCall<{ challengeId?: string; ready?: true }>(uid, 'initialize')
  if (r.challengeId) await executeChallenge(uid, r.challengeId)
  // Circle makes the wallet right after the challenge; it shows up within seconds.
  for (let i = 0; i < 20; i++) {
    try { return (await circleCall<{ address: Hex }>(uid, 'wallet')).address }
    catch (e) { if (!(e instanceof CircleError && e.code === 'no-wallet')) throw e }
    await new Promise(res => setTimeout(res, 1000))
  }
  throw new CircleError(504, 'no-wallet', 'Your wallet is still being set up - try again in a minute')
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
    const { challengeId } = await circleCall<{ challengeId: string }>(uid, action, body)
    return executeChallenge(uid, challengeId)
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

/** The signed-in account's Circle signer for `address`, if this browser has its Circle session. */
export async function restoreCircleAccount(address: string): Promise<CircleAccount | null> {
  const a = await meshportAccount()
  if (!a || a.anonymous || !loadCircleSession(a.uid)) return null
  return circleAccount(address, a.uid)
}

/** At sign-in: the Circle signer when `address` (the account's wallet) is this account's Circle wallet. */
export async function circleSignerFor(uid: string, address: string): Promise<CircleAccount | null> {
  if (!circleConfigured() || !loadCircleSession(uid)) return null
  try {
    const w = await circleCall<{ address: string }>(uid, 'wallet')
    return w.address.toLowerCase() === address.toLowerCase() ? circleAccount(w.address, uid) : null
  } catch { return null }
}

export function signOutCircle(uid: string): void { saveCircleSession(uid, null) }
