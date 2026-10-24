import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

// The app side of Circle wallets, with the backend faked at fetch, the
// Supabase session faked, and Circle's SDK faked: session refresh, the
// combined Google sign-in, and the Circle signer.

let sessionUser: { id: string; email: string; is_anonymous?: boolean } | null = { id: 'uid-alice', email: 'alice@example.com' }
const signInWithIdToken = vi.fn(async (_: unknown) => ({ data: { user: { id: 'uid-alice' } }, error: null as unknown }))
vi.mock('@/lib/supabase', () => ({
  authApiHeaders: async () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer supa' }),
  supabase: { auth: {
    getSession: async () => ({ data: { session: sessionUser ? { user: sessionUser } : null } }),
    signInWithIdToken: (a: unknown) => signInWithIdToken(a),
  } },
}))
vi.mock('./account', () => ({ plainTransaction: (tx: Record<string, unknown>) => ({ ...tx }) }))

// Circle's SDK: the login callback fires with this result; execute() answers from sdkExecute.
let sdkLoginResult: { error?: unknown; result?: unknown } = { result: { userToken: 'ut-google', encryptionKey: 'ek-google', refreshToken: 'rt-google' } }
let sdkExecute: (id: string) => { error?: unknown; result?: unknown } = () => ({ result: { status: 'COMPLETE', data: { signature: '0xsig' } } })
let sdkAuth: unknown = null
vi.mock('@circle-fin/w3s-pw-web-sdk/dist/src/types', async () => vi.importActual('@circle-fin/w3s-pw-web-sdk/dist/src/types'))
vi.mock('@circle-fin/w3s-pw-web-sdk', () => ({
  W3SSdk: class {
    constructor(_c: unknown, onLogin?: (e: unknown, r: unknown) => void) { if (onLogin) queueMicrotask(() => onLogin(sdkLoginResult.error, sdkLoginResult.result)) }
    updateConfigs(_c: unknown, onLogin?: (e: unknown, r: unknown) => void) { if (onLogin) queueMicrotask(() => onLogin(sdkLoginResult.error, sdkLoginResult.result)) }
    getDeviceId() { return Promise.resolve('device-1234567890') }
    setAuthentication(a: unknown) { sdkAuth = a }
    execute(id: string, cb: (e: unknown, r: unknown) => void) { const o = sdkExecute(id); queueMicrotask(() => cb(o.error, o.result)) }
  },
}))

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
})
let assigned: string | null = null
vi.stubGlobal('window', { location: { origin: 'https://meshport.xyz', hash: '', assign: (u: string) => { assigned = u } } })

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

const circle = await import('./circle')
const { circleCall, finishGoogleSignIn, startGoogleSignIn, loadCircleSession, saveCircleSession, circleAccount } = circle

beforeEach(() => {
  store.clear(); replies = []; sent = []; assigned = null; sdkAuth = null
  sessionUser = { id: 'uid-alice', email: 'alice@example.com' }
  sdkLoginResult = { result: { userToken: 'ut-google', encryptionKey: 'ek-google', refreshToken: 'rt-google' } }
  sdkExecute = () => ({ result: { status: 'COMPLETE', data: { signature: '0xsig' } } })
  signInWithIdToken.mockClear()
  ;(window as any).location.hash = ''
})

describe('circleCall', () => {
  it('sends the stored Circle session with the call', async () => {
    saveCircleSession('uid-alice', { userToken: 'ut-1', encryptionKey: 'ek', refreshToken: 'rt' })
    replies = [() => [200, { address: '0xa' }]]
    expect(await circleCall('uid-alice', 'wallet')).toEqual({ address: '0xa' })
    expect(sent[0]).toEqual({ action: 'wallet', userToken: 'ut-1' })
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
    expect(sent[2].userToken).toBe('ut-new')
    expect(loadCircleSession('uid-alice')).toEqual({ userToken: 'ut-new', encryptionKey: 'ek2', refreshToken: 'rt2' })
  })

  it('a refresh that fails forgets the session; other refusals are not retried', async () => {
    saveCircleSession('uid-alice', { userToken: 'ut-old', encryptionKey: 'ek', refreshToken: 'rt' })
    store.set('mp.circle.deviceId', JSON.stringify('device-1'))
    replies = [() => [401, { code: 'session' }], () => [401, { code: 'session' }]]
    await expect(circleCall('uid-alice', 'wallet')).rejects.toMatchObject({ code: 'session' })
    expect(loadCircleSession('uid-alice')).toBeNull()

    saveCircleSession('uid-alice', { userToken: 'ut', encryptionKey: 'ek', refreshToken: 'rt' })
    sent = []; replies = [() => [409, { code: 'linked-elsewhere', error: 'different account' }]]
    await expect(circleCall('uid-alice', 'wallet')).rejects.toMatchObject({ status: 409, code: 'linked-elsewhere' })
    expect(sent).toHaveLength(1)
  })
})

describe('Google sign-in for MeshPort and Circle at once', () => {
  async function start() {
    replies = [() => [200, { deviceToken: 'dt', deviceEncryptionKey: 'dek' }]]
    await startGoogleSignIn({ meshport: true })
    return new URL(assigned!)
  }
  /** What Google sends back: the token's nonce is the one Google was given. */
  function googleReturns(url: URL, over: Record<string, string> = {}) {
    const p = new URLSearchParams({ id_token: 'google-id-token', access_token: 'google-access', state: url.searchParams.get('state')!, ...over })
    ;(window as any).location.hash = '#' + p.toString()
  }

  it('Google gets sha256(raw nonce), Circle\'s SDK keys hold the same, and Supabase gets the raw one', async () => {
    const url = await start()
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('redirect_uri')).toBe('https://meshport.xyz/wallet/circle-login')
    expect(url.searchParams.get('response_type')).toBe('id_token token')
    expect(store.get('socialLoginProvider')).toBe('Google') // the SDK's own spelling, or it never checks with Circle
    expect(store.get('state')).toBe(url.searchParams.get('state'))
    expect(store.get('nonce')).toBe(url.searchParams.get('nonce'))
    const raw = JSON.parse(store.get('mp.circle.pendingLogin')!).rawNonce
    expect(createHash('sha256').update(raw).digest('hex')).toBe(url.searchParams.get('nonce'))

    googleReturns(url)
    replies = [() => [200, { circleUserId: 'circle-alice' }]] // link
    expect(await finishGoogleSignIn()).toEqual({ returnTo: '/auth/google' })
    expect(signInWithIdToken).toHaveBeenCalledWith({ provider: 'google', token: 'google-id-token', access_token: 'google-access', nonce: raw })
    expect(sent[sent.length - 1]).toEqual({ action: 'link', userToken: 'ut-google' })
    expect(loadCircleSession('uid-alice')).toEqual({ userToken: 'ut-google', encryptionKey: 'ek-google', refreshToken: 'rt-google' })
  })

  it('a Circle hiccup does not stop the MeshPort sign-in', async () => {
    const url = await start()
    googleReturns(url)
    sdkLoginResult = { error: { message: 'Circle is down' } }
    const r = await finishGoogleSignIn()
    expect(r).toMatchObject({ returnTo: '/auth/google', circleError: 'Circle is down' })
    expect(signInWithIdToken).toHaveBeenCalled()
    expect(loadCircleSession('uid-alice')).toBeNull()
  })

  it('refuses a return with the wrong state, a cancelled Google screen, or no sign-in started here', async () => {
    let url = await start()
    googleReturns(url, { state: 'forged' })
    await expect(finishGoogleSignIn()).rejects.toThrow(/failed/)
    expect(signInWithIdToken).not.toHaveBeenCalled()

    url = await start()
    googleReturns(url, { error: 'access_denied' })
    await expect(finishGoogleSignIn()).rejects.toThrow(/cancelled/)

    await expect(finishGoogleSignIn()).rejects.toThrow(/expired/) // pending was used up
  })

  it('a Circle-only sign-in refuses when a different MeshPort account is signed in now', async () => {
    replies = [() => [200, { deviceToken: 'dt', deviceEncryptionKey: 'dek' }]]
    await startGoogleSignIn({ meshport: false, uid: 'uid-alice', returnTo: '/circle-wallet' })
    googleReturns(new URL(assigned!))
    sessionUser = { id: 'uid-mallory', email: 'm@example.com' }
    await expect(finishGoogleSignIn()).rejects.toThrow(/signed out of MeshPort/)
    expect(signInWithIdToken).not.toHaveBeenCalled()
  })
})

describe('circleAccount (the Circle signer)', () => {
  beforeEach(() => saveCircleSession('uid-alice', { userToken: 'ut', encryptionKey: 'ek', refreshToken: 'rt' }))

  it('signs a transaction through a Circle challenge and returns the signed transaction', async () => {
    replies = [() => [200, { challengeId: 'c1' }]]
    sdkExecute = id => ({ result: { status: 'COMPLETE', data: { signature: '0xs', signedTransaction: id === 'c1' ? '0x02f8signed' : '0xwrong' } } })
    const acct = circleAccount('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'uid-alice')
    const raw = await acct.signTransaction({ chainId: 5042002, to: '0x2222222222222222222222222222222222222222', nonce: 1, gas: 21000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, type: 'eip1559' })
    expect(raw).toBe('0x02f8signed')
    expect(sent[0]).toMatchObject({ action: 'sign-transaction', userToken: 'ut', transaction: { chainId: 5042002, gas: '21000', maxFeePerGas: '10' } })
    expect(sdkAuth).toEqual({ userToken: 'ut', encryptionKey: 'ek' })
  })

  it('signs messages (text and raw hex) and typed data with the EIP712Domain type added', async () => {
    const acct = circleAccount('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'uid-alice')
    replies = [() => [200, { challengeId: 'c1' }], () => [200, { challengeId: 'c2' }], () => [200, { challengeId: 'c3' }]]
    expect(await acct.signMessage({ message: 'hello' })).toBe('0xsig')
    expect(sent[0]).toMatchObject({ action: 'sign-message', message: 'hello' })
    await acct.signMessage({ message: { raw: '0xdeadbeef' } })
    expect(sent[1]).toMatchObject({ message: '0xdeadbeef', encodedByHex: true })
    await acct.signTypedData({ domain: { name: 'X', chainId: 5042002 }, types: { Mail: [{ name: 'v', type: 'uint256' }] }, primaryType: 'Mail', message: { v: 1n } })
    expect(sent[2].typedData.types.EIP712Domain).toEqual([{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }])
    expect(sent[2].typedData.message.v).toBe('1')
  })

  it('two signatures at once both finish (the SDK holds one callback, so they queue)', async () => {
    // Like the real SDK: one pending callback; a second execute() replaces the first's.
    let pending: { id: string; cb: (e: unknown, r: unknown) => void } | null = null
    const W = (await import('@circle-fin/w3s-pw-web-sdk')).W3SSdk.prototype as any
    const original = W.execute
    W.execute = function (id: string, cb: (e: unknown, r: unknown) => void) {
      pending = { id, cb }
      setTimeout(() => { if (pending?.id === id) { const p = pending; pending = null; p.cb(undefined, { data: { signature: '0xsig-' + id } }) } }, 5)
    }
    try {
      replies = [() => [200, { challengeId: 'a' }], () => [200, { challengeId: 'b' }]]
      const acct = circleAccount('0xcccccccccccccccccccccccccccccccccccccccc', 'uid-alice')
      const both = await Promise.all([acct.signMessage({ message: 'one' }), acct.signMessage({ message: 'two' })])
      expect(both.sort()).toEqual(['0xsig-a', '0xsig-b'])
    } finally { W.execute = original }
  })

  it('a refused challenge is an error, not a signature', async () => {
    replies = [() => [200, { challengeId: 'c1' }]]
    sdkExecute = () => ({ error: { code: 155701, message: 'User canceled' } })
    const acct = circleAccount('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'uid-alice')
    await expect(acct.signMessage({ message: 'x' })).rejects.toThrow(/canceled/)
  })
})
