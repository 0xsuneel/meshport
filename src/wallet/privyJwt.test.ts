import { describe, it, expect } from 'vitest'
import {
  createJwtProvider, jwtExpiry, needsResync, resyncDelayMs, nextSessionState, RESYNC_BEFORE_REBUILD,
  type SessionResult, type SupabaseSessionState,
} from './privyJwt'

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (expSec: number) => `${b64({ alg: 'ES256' })}.${b64({ exp: expSec })}.sig`
const NOW = 1_700_000_000_000
const ok = (token: string): SessionResult => ({ data: { session: { access_token: token } }, error: null })
const failed = (): SessionResult => ({ data: { session: null }, error: new Error('fetch failed') })
const signedOut = (): SessionResult => ({ data: { session: null }, error: null })

function provider(results: SessionResult[], opts: { now?: () => number } = {}) {
  let i = 0
  const waits: number[] = []
  const p = createJwtProvider({
    getSession: async () => results[Math.min(i++, results.length - 1)],
    wait: async ms => { waits.push(ms) },
    now: opts.now ?? (() => NOW),
    onWake: () => () => {},
  })
  return { p, waits, calls: () => i }
}

describe('jwtExpiry', () => {
  it('reads exp, and is null for anything else', () => {
    expect(jwtExpiry(jwt(123))).toBe(123)
    expect(jwtExpiry('nope')).toBeNull()
    expect(jwtExpiry(`${b64({})}.${b64({})}.x`)).toBeNull()
  })
})

describe('createJwtProvider - never says "no token" while the session exists', () => {
  it('hands out the current token', async () => {
    const t = jwt(NOW / 1000 + 3600)
    expect(await provider([ok(t)]).p.get()).toBe(t)
  })

  it('a real sign-out (no session, no error) is the only "no token"', async () => {
    expect(await provider([signedOut()]).p.get()).toBeUndefined()
  })

  it('a refresh that fails is waited out and retried, with backoff, not answered with undefined', async () => {
    const t = jwt(NOW / 1000 + 3600)
    const { p, waits } = provider([failed(), failed(), failed(), ok(t)])
    expect(await p.get()).toBe(t)
    expect(waits).toEqual([1_000, 2_000, 4_000])
  })

  it('a getSession that throws is the same as a failed refresh', async () => {
    const t = jwt(NOW / 1000 + 3600)
    let n = 0
    const p = createJwtProvider({
      getSession: async () => { if (n++ === 0) throw new Error('offline'); return ok(t) },
      wait: async () => {}, now: () => NOW, onWake: () => () => {},
    })
    expect(await p.get()).toBe(t)
  })

  it('while the refresh fails, the token Privy already has (still valid) is handed out again - the same token is a no-op for Privy', async () => {
    const t = jwt(NOW / 1000 + 600)
    const { p, waits } = provider([ok(t), failed()])
    expect(await p.get()).toBe(t)
    expect(await p.get()).toBe(t)
    expect(waits).toEqual([])
  })

  it('but not one that is about to expire or has expired: it waits for a fresh one', async () => {
    const old = jwt(NOW / 1000 + 5)
    const fresh = jwt(NOW / 1000 + 3600)
    const { p, waits } = provider([ok(old), failed(), ok(fresh)])
    await p.get()
    expect(await p.get()).toBe(fresh)
    expect(waits).toEqual([1_000])
  })

  it('caps the backoff at 15 s', async () => {
    const t = jwt(NOW / 1000 + 3600)
    const { p, waits } = provider([...Array(8).fill(null).map(failed), ok(t)])
    await p.get()
    expect(Math.max(...waits)).toBe(15_000)
  })

  it('a replaced Privy never settles, so it cannot log out the session its replacement shares', async () => {
    const { p } = provider([failed()])
    p.abort()
    const outcome = await Promise.race([p.get().then(() => 'settled'), new Promise(r => setTimeout(() => r('pending'), 30))])
    expect(outcome).toBe('pending')
    p.resume()
    expect(await provider([signedOut()]).p.get()).toBeUndefined()
  })
})

describe('needsResync / resyncDelayMs', () => {
  const base = { signedIn: true, ready: true, authenticated: false, status: 'error' as const }
  it('Privy up, MeshPort signed in, Privy not: start it again', () => {
    expect(needsResync(base)).toBe(true)
    expect(needsResync({ ...base, status: 'done' })).toBe(true)
  })
  it('not while a sync is running, once authenticated, signed out, or Privy not loaded', () => {
    expect(needsResync({ ...base, status: 'loading' })).toBe(false)
    expect(needsResync({ ...base, authenticated: true })).toBe(false)
    expect(needsResync({ ...base, signedIn: false })).toBe(false)
    expect(needsResync({ ...base, ready: false })).toBe(false)
  })
  it('retries at 2, 5, 10, 20, then every 30 s; rebuilds after a few', () => {
    expect([0, 1, 2, 3, 4, 9].map(resyncDelayMs)).toEqual([2_000, 5_000, 10_000, 20_000, 30_000, 30_000])
    expect(RESYNC_BEFORE_REBUILD).toBeGreaterThan(0)
  })
})

describe('nextSessionState - a failing refresh is not a sign-out', () => {
  const loaded = (token = 't1', anonymous = false): SupabaseSessionState => ({ session: { token, anonymous }, loading: false })
  const sess = (token: string, anon = false) => ({ access_token: token, user: { is_anonymous: anon } })

  it('the first read sets the session (or none)', () => {
    expect(nextSessionState({ session: null, loading: true }, 'INITIAL_SESSION', sess('a'))).toEqual(loaded('a'))
    expect(nextSessionState({ session: null, loading: true }, 'INITIAL_SESSION', null)).toEqual({ session: null, loading: false })
  })
  it('a null session that is not SIGNED_OUT keeps the signed-in session', () => {
    const prev = loaded()
    expect(nextSessionState(prev, 'TOKEN_REFRESHED', null)).toBe(prev)
    expect(nextSessionState(prev, 'INITIAL_SESSION', null)).toBe(prev)
  })
  it('SIGNED_OUT really signs out', () => {
    expect(nextSessionState(loaded(), 'SIGNED_OUT', null)).toEqual({ session: null, loading: false })
  })
  it('a refreshed token updates the session; the same one returns the same object', () => {
    const prev = loaded('t1')
    expect(nextSessionState(prev, 'TOKEN_REFRESHED', sess('t2'))).toEqual(loaded('t2'))
    expect(nextSessionState(prev, 'SIGNED_IN', sess('t1'))).toBe(prev)
  })
  it('anonymous to real is a change', () => {
    expect(nextSessionState(loaded('t1', true), 'SIGNED_IN', sess('t2', false)).session?.anonymous).toBe(false)
  })
})
