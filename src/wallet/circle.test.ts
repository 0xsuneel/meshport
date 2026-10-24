import { describe, it, expect, vi, beforeEach } from 'vitest'

// The app side of Circle wallets, with the backend faked at fetch and the
// Supabase session faked: session refresh, and the Google return page's checks.

let sessionUser: { id: string; email: string; is_anonymous?: boolean } | null = { id: 'uid-alice', email: 'alice@example.com' }
vi.mock('@/lib/supabase', () => ({
  authApiHeaders: async () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer supa' }),
  supabase: { auth: { getSession: async () => ({ data: { session: sessionUser ? { user: sessionUser } : null } }) } },
}))
vi.mock('@circle-fin/w3s-pw-web-sdk', () => ({ W3SSdk: class { updateConfigs() {} } }))

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
})

let replies: Array<(body: any) => [number, unknown]>
let sent: any[]
vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body))
  sent.push(body)
  const next = replies.shift()
  if (!next) throw new Error('unexpected call ' + body.action)
  const [status, json] = next(body)
  return new Response(JSON.stringify(json), { status })
}))

const { circleCall, finishGoogleLogin, loadCircleSession, saveCircleSession } = await import('./circle')

beforeEach(() => { store.clear(); replies = []; sent = []; sessionUser = { id: 'uid-alice', email: 'alice@example.com' } })

describe('circleCall', () => {
  it('sends the stored Circle session with the call', async () => {
    saveCircleSession('uid-alice', { userToken: 'ut-1', encryptionKey: 'ek', refreshToken: 'rt' })
    replies = [() => [200, { balances: [] }]]
    expect(await circleCall('uid-alice', 'balances')).toEqual({ balances: [] })
    expect(sent[0]).toEqual({ action: 'balances', userToken: 'ut-1' })
  })

  it('an expired session is refreshed once and the call retried with the new token', async () => {
    saveCircleSession('uid-alice', { userToken: 'ut-old', encryptionKey: 'ek', refreshToken: 'rt' })
    store.set('mp.circle.deviceId', JSON.stringify('device-1'))
    replies = [
      () => [401, { code: 'session', error: 'expired' }],
      () => [200, { userToken: 'ut-new', encryptionKey: 'ek2', refreshToken: 'rt2' }],
      () => [200, { ok: true }],
    ]
    expect(await circleCall('uid-alice', 'wallet')).toEqual({ ok: true })
    expect(sent.map(b => b.action)).toEqual(['wallet', 'refresh', 'wallet'])
    expect(sent[1]).toMatchObject({ userToken: 'ut-old', refreshToken: 'rt', deviceId: 'device-1' })
    expect(sent[2].userToken).toBe('ut-new')
    expect(loadCircleSession('uid-alice')).toEqual({ userToken: 'ut-new', encryptionKey: 'ek2', refreshToken: 'rt2' })
  })

  it('a refresh that fails forgets the session, so the user signs in again', async () => {
    saveCircleSession('uid-alice', { userToken: 'ut-old', encryptionKey: 'ek', refreshToken: 'rt' })
    store.set('mp.circle.deviceId', JSON.stringify('device-1'))
    replies = [() => [401, { code: 'session' }], () => [401, { code: 'session' }]]
    await expect(circleCall('uid-alice', 'wallet')).rejects.toMatchObject({ code: 'session' })
    expect(loadCircleSession('uid-alice')).toBeNull()
  })

  it('other refusals are not retried', async () => {
    saveCircleSession('uid-alice', { userToken: 'ut', encryptionKey: 'ek', refreshToken: 'rt' })
    replies = [() => [409, { code: 'linked-elsewhere', error: 'different account' }]]
    await expect(circleCall('uid-alice', 'wallet')).rejects.toMatchObject({ status: 409, code: 'linked-elsewhere' })
    expect(sent).toHaveLength(1)
  })

  it('no session: asks to sign in without calling the backend', async () => {
    await expect(circleCall('uid-alice', 'wallet')).rejects.toMatchObject({ code: 'session' })
    expect(sent).toHaveLength(0)
  })
})

describe('finishGoogleLogin (the page Google returns to)', () => {
  const pending = (over: Record<string, unknown> = {}) => store.set('mp.circle.pendingLogin', JSON.stringify({
    uid: 'uid-alice', deviceToken: 'dt', deviceEncryptionKey: 'dek', returnTo: '/circle-wallet', at: Date.now(), ...over,
  }))

  it('refuses when no sign-in was started here', async () => {
    await expect(finishGoogleLogin()).rejects.toThrow(/expired/)
  })

  it('refuses a sign-in started long ago, and only once', async () => {
    pending({ at: Date.now() - 60 * 60_000 })
    await expect(finishGoogleLogin()).rejects.toThrow(/expired/)
    expect(store.has('mp.circle.pendingLogin')).toBe(false)
  })

  it('refuses when a different MeshPort account is signed in now', async () => {
    pending()
    sessionUser = { id: 'uid-mallory', email: 'm@example.com' }
    await expect(finishGoogleLogin()).rejects.toThrow(/signed out of MeshPort/)
  })
})
