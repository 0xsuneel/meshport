// src/wallet/circle.ts
//
// The app side of Circle user-controlled wallets (docs/CIRCLE_WALLETS.md).
// Circle's Web SDK shows Circle's own screens (Google / email-code sign-in,
// approving a payment) in a frame from pw-auth.circle.com; MeshPort's backend
// (api/circle-wallet.ts) talks to Circle's API. Keys never reach this app.
//
// The Circle session (userToken + encryptionKey + refreshToken) is kept per
// MeshPort account in this browser. A call the backend rejects as an expired
// session is refreshed once and retried.

import { authApiHeaders, supabase } from '@/lib/supabase'
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

export const loadCircleSession = (uid: string): CircleSession | null => read<CircleSession>(SESSION_KEY(uid))
export const saveCircleSession = (uid: string, s: CircleSession | null): void => write(SESSION_KEY(uid), s)

/** Who is signed in to MeshPort (Google / email, not an anonymous session). */
export async function meshportAccount(): Promise<{ uid: string; email: string | null; anonymous: boolean } | null> {
  const u = (await supabase.auth.getSession()).data.session?.user
  return u ? { uid: u.id, email: u.email ?? null, anonymous: u.is_anonymous === true } : null
}

// ── backend ─────────────────────────────────────────────────────────────────

export async function circleApi<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch('/api/circle-wallet', { method: 'POST', headers: await authApiHeaders(), body: JSON.stringify({ action, ...body }) })
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

// ── Circle's Web SDK (loaded only when a Circle screen is needed) ───────────

let sdkPromise: Promise<W3SSdk> | null = null
type LoginCallback = (error: unknown, result: unknown) => void
type LoginConfigs = { deviceToken: string; deviceEncryptionKey: string; otpToken?: string; email?: { email: string }; google?: { clientId: string; redirectUri: string; selectAccountPrompt?: boolean } }

/** The SDK, with these login settings. Constructing it also picks up a Google
 *  sign-in result in the page address (after Google sends the user back). */
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

const googleConfig = () => ({ clientId: GOOGLE_CLIENT_ID, redirectUri: window.location.origin + CIRCLE_LOGIN_PATH, selectAccountPrompt: true })

function loginResult(error: unknown, result: unknown): CircleSession {
  const r = result as { userToken?: string; encryptionKey?: string; refreshToken?: string } | undefined
  if (error || !r?.userToken || !r.encryptionKey) {
    const m = (error as { message?: string } | undefined)?.message
    throw new CircleError(401, 'login', m || 'Circle sign-in did not finish')
  }
  return { userToken: r.userToken, encryptionKey: r.encryptionKey, refreshToken: r.refreshToken }
}

/** Link the Circle sign-in to this MeshPort account and keep the session. */
async function finishLogin(uid: string, s: CircleSession): Promise<void> {
  await circleApi('link', { userToken: s.userToken }) // refuses a Circle sign-in that belongs to another account
  saveCircleSession(uid, s)
}

/** Sign in with Google through Circle: leaves the page for Google, then
 *  comes back to CIRCLE_LOGIN_PATH (finishGoogleLogin). */
export async function startGoogleLogin(uid: string, returnTo: string): Promise<void> {
  const id = await deviceId()
  const t = await circleApi<{ deviceToken: string; deviceEncryptionKey: string }>('social-device-token', { deviceId: id })
  write(PENDING_KEY, { uid, deviceToken: t.deviceToken, deviceEncryptionKey: t.deviceEncryptionKey, returnTo, at: Date.now() })
  const s = await sdk({ deviceToken: t.deviceToken, deviceEncryptionKey: t.deviceEncryptionKey, google: googleConfig() })
  const { SocialLoginProvider } = await import('@circle-fin/w3s-pw-web-sdk/dist/src/types')
  s.performLogin(SocialLoginProvider.GOOGLE)
}

/** On CIRCLE_LOGIN_PATH: let the SDK verify Google's answer with Circle, then link. */
export async function finishGoogleLogin(): Promise<{ returnTo: string }> {
  const p = read<{ uid: string; deviceToken: string; deviceEncryptionKey: string; returnTo: string; at: number }>(PENDING_KEY)
  write(PENDING_KEY, null)
  if (!p || Date.now() - p.at > PENDING_MAX_AGE_MS) throw new CircleError(400, 'login', 'That sign-in expired - start again')
  const account = await meshportAccount()
  if (account?.uid !== p.uid) throw new CircleError(401, 'login', 'You were signed out of MeshPort - sign in and start again')
  const session = await new Promise<CircleSession>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CircleError(504, 'login', 'Circle did not answer - try again')), 45_000)
    sdk({ deviceToken: p.deviceToken, deviceEncryptionKey: p.deviceEncryptionKey, google: googleConfig() }, (error, result) => {
      clearTimeout(timer)
      try { resolve(loginResult(error, result)) } catch (e) { reject(e) }
    }).catch(e => { clearTimeout(timer); reject(e) })
  })
  await finishLogin(p.uid, session)
  return { returnTo: p.returnTo.startsWith('/') && !p.returnTo.startsWith('//') ? p.returnTo : '/circle-wallet' }
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

/** Show Circle's screen for a challenge (create wallet, approve a payment…). */
export async function executeChallenge(uid: string, challengeId: string): Promise<{ status?: string; type?: string; signature?: string }> {
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
      const r = result as { status?: string; type?: string; data?: { signature?: string } } | undefined
      resolve({ status: r?.status, type: r?.type, signature: r?.data?.signature })
    })
  })
}

export function signOutCircle(uid: string): void { saveCircleSession(uid, null) }
