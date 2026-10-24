import { describe, it, expect, beforeEach } from 'vitest'
import { createCircleClient, CircleApiError } from './client'
import { createCircleWalletService, CIRCLE_CHAIN, type CircleLink, type CircleRepo } from './service'

// ── A fake Circle API (fetch level): users, sessions, wallets, balances ─────
const API_KEY = 'TEST_API_KEY:abc123:secret456'
const ALICE_TOKEN = 'alice-user-token-' + 'x'.repeat(40)
const BOB_TOKEN = 'bob-user-token-' + 'y'.repeat(40)
const EXPIRED_TOKEN = 'expired-user-token-' + 'z'.repeat(40)
const USDC_ID = '11111111-1111-4111-8111-111111111111'
const ALICE_WALLET = '22222222-2222-4222-8222-222222222222'
const BOB_WALLET = '33333333-3333-4333-8333-333333333333'

let calls: Array<{ method: string; path: string; headers: Record<string, string>; body: any }>
let initialized: Set<string>

function fakeCircle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input))
  const headers = Object.fromEntries(new Headers(init?.headers).entries())
  const body = init?.body ? JSON.parse(String(init.body)) : null
  calls.push({ method: init?.method ?? 'GET', path: url.pathname, headers, body })
  const reply = (status: number, j: unknown) => Promise.resolve(new Response(JSON.stringify(j), { status }))
  if (headers.authorization !== `Bearer ${API_KEY}`) return reply(401, { code: 401, message: 'bad key' })
  const token = headers['x-user-token']
  if (token === EXPIRED_TOKEN) return reply(403, { code: 155104, message: 'The user token has expired' })
  const user = token === ALICE_TOKEN ? 'circle-alice' : token === BOB_TOKEN ? 'circle-bob' : null
  const key = `${init?.method ?? 'GET'} ${url.pathname}`
  switch (key) {
    case 'POST /v1/w3s/users/social/token': return reply(200, { data: { deviceToken: 'dt', deviceEncryptionKey: 'dek' } })
    case 'POST /v1/w3s/users/email/token': return reply(200, { data: { deviceToken: 'dt', deviceEncryptionKey: 'dek', otpToken: 'otp' } })
    case 'GET /v1/w3s/user': return user ? reply(200, { data: { id: user, status: 'ENABLED' } }) : reply(401, { code: 401, message: 'no' })
    case 'POST /v1/w3s/user/initialize':
      if (initialized.has(user!)) return reply(409, { code: 155106, message: 'The user has already been initialized' })
      initialized.add(user!)
      return reply(200, { data: { challengeId: '44444444-4444-4444-8444-444444444444' } })
    case 'GET /v1/w3s/wallets': {
      if (!initialized.has(user!)) return reply(200, { data: { wallets: [] } })
      const id = user === 'circle-alice' ? ALICE_WALLET : BOB_WALLET
      return reply(200, { data: { wallets: [
        { id: '99999999-9999-4999-8999-999999999999', address: '0x9999999999999999999999999999999999999999', blockchain: 'BASE-SEPOLIA', state: 'LIVE', accountType: 'EOA', createDate: '2026-01-01T00:00:00Z' },
        { id, address: user === 'circle-alice' ? '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' : '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', blockchain: CIRCLE_CHAIN, state: 'LIVE', accountType: 'EOA', createDate: '2026-01-02T00:00:00Z' },
      ] } })
    }
    case `GET /v1/w3s/wallets/${ALICE_WALLET}/balances`:
      return reply(200, { data: { tokenBalances: [{ amount: '12.5', token: { id: USDC_ID, symbol: 'USDC', isNative: true, decimals: 6 } }] } })
    case 'POST /v1/w3s/user/transactions/transfer':
    case 'POST /v1/w3s/user/transactions/contractExecution':
    case 'POST /v1/w3s/user/sign/message':
    case 'POST /v1/w3s/user/sign/typedData':
      return reply(200, { data: { challengeId: '55555555-5555-4555-8555-555555555555' } })
    case 'GET /v1/w3s/transactions/66666666-6666-4666-8666-666666666666':
      return reply(200, { data: { transaction: { id: '66666666-6666-4666-8666-666666666666', state: 'COMPLETE', txHash: '0xabc', walletId: BOB_WALLET } } })
  }
  return reply(404, { code: 404, message: `unexpected ${key}` })
}

class MemoryRepo implements CircleRepo {
  rows = new Map<string, CircleLink>()
  async link(uid: string) { return this.rows.get(uid) ?? null }
  async saveLink(uid: string, circleUserId: string) {
    if ([...this.rows.values()].some(r => r.circleUserId === circleUserId)) return 'taken' as const
    this.rows.set(uid, { circleUserId, walletId: null, address: null })
    return 'saved' as const
  }
  async saveWallet(uid: string, walletId: string, address: string) { this.rows.set(uid, { ...this.rows.get(uid)!, walletId, address }) }
}

let repo: MemoryRepo
let svc: ReturnType<typeof createCircleWalletService>
const lastCall = (path: string) => [...calls].reverse().find(c => c.path === path)!

beforeEach(() => {
  calls = []
  initialized = new Set()
  repo = new MemoryRepo()
  svc = createCircleWalletService({ circle: createCircleClient({ apiKey: API_KEY, fetch: fakeCircle as typeof fetch }), repo })
})

describe('Circle client', () => {
  it('sends the API key as a bearer token and the user session as X-User-Token; maps errors', async () => {
    const c = createCircleClient({ apiKey: API_KEY, fetch: fakeCircle as typeof fetch })
    expect(await c.request('GET', '/v1/w3s/user', { userToken: ALICE_TOKEN })).toEqual({ id: 'circle-alice', status: 'ENABLED' })
    expect(lastCall('/v1/w3s/user').headers['x-user-token']).toBe(ALICE_TOKEN)
    await expect(c.request('GET', '/v1/w3s/user', { userToken: EXPIRED_TOKEN })).rejects.toMatchObject({ status: 403, code: 155104 })
    await expect(c.request('GET', '/v1/w3s/nope')).rejects.toBeInstanceOf(CircleApiError)
    expect(() => createCircleClient({ apiKey: 'not-a-key' })).toThrow(/PREFIX:ID:SECRET/)
  })
})

describe('Circle wallet service', () => {
  it('links one MeshPort account to one Circle user, both ways', async () => {
    expect(await svc.link('uid-alice', ALICE_TOKEN)).toMatchObject({ circleUserId: 'circle-alice' })
    expect(await svc.link('uid-alice', ALICE_TOKEN)).toMatchObject({ circleUserId: 'circle-alice' }) // again: fine
    await expect(svc.link('uid-mallory', ALICE_TOKEN)).rejects.toMatchObject({ code: 'linked-elsewhere' }) // Alice's Circle login, another account
    await expect(svc.link('uid-alice', BOB_TOKEN)).rejects.toMatchObject({ code: 'linked-elsewhere' }) // Alice's account, Bob's Circle login
  })

  it("acts only with this account's own Circle session", async () => {
    await svc.link('uid-alice', ALICE_TOKEN)
    await svc.link('uid-bob', BOB_TOKEN)
    await expect(svc.initialize('uid-nobody', ALICE_TOKEN)).rejects.toMatchObject({ code: 'not-linked' })
    await expect(svc.balances('uid-alice', BOB_TOKEN)).rejects.toMatchObject({ code: 'linked-elsewhere' })
    await expect(svc.balances('uid-alice', EXPIRED_TOKEN)).rejects.toMatchObject({ code: 'session' })
    await expect(svc.balances('uid-alice', undefined)).rejects.toMatchObject({ code: 'session' })
  })

  it('first use: an initialize challenge for an Arc EOA wallet, then finds and remembers that wallet', async () => {
    await svc.link('uid-alice', ALICE_TOKEN)
    await expect(svc.wallet('uid-alice', ALICE_TOKEN)).rejects.toMatchObject({ code: 'no-wallet' })
    expect(await svc.initialize('uid-alice', ALICE_TOKEN)).toEqual({ challengeId: '44444444-4444-4444-8444-444444444444' })
    expect(lastCall('/v1/w3s/user/initialize').body).toMatchObject({ accountType: 'EOA', blockchains: [CIRCLE_CHAIN] })
    expect(await svc.initialize('uid-alice', ALICE_TOKEN)).toEqual({ initialized: true }) // already done
    const w = await svc.wallet('uid-alice', ALICE_TOKEN)
    expect(w).toEqual({ walletId: ALICE_WALLET, address: '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa', blockchain: CIRCLE_CHAIN }) // the Arc one, checksummed
    calls = []
    await svc.wallet('uid-alice', ALICE_TOKEN)
    expect(calls.map(c => c.path)).not.toContain('/v1/w3s/wallets') // remembered
  })

  it('a transfer: wallet and token resolved on the server, idempotency key kept, input checked', async () => {
    await svc.link('uid-alice', ALICE_TOKEN)
    await svc.initialize('uid-alice', ALICE_TOKEN)
    const key = '77777777-7777-4777-8777-777777777777'
    const r = await svc.transfer('uid-alice', ALICE_TOKEN, { to: '0x2222222222222222222222222222222222222222', amount: '1.50', idempotencyKey: key })
    expect(r).toEqual({ challengeId: '55555555-5555-4555-8555-555555555555', idempotencyKey: key })
    expect(lastCall('/v1/w3s/user/transactions/transfer').body).toEqual({
      idempotencyKey: key, walletId: ALICE_WALLET, destinationAddress: '0x2222222222222222222222222222222222222222',
      amounts: ['1.50'], tokenId: USDC_ID, feeLevel: 'MEDIUM',
    })
    const t = (x: Record<string, unknown>) => svc.transfer('uid-alice', ALICE_TOKEN, { to: '0x2222222222222222222222222222222222222222', amount: '1', ...x })
    await expect(t({ to: '0x123' })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(t({ amount: '0' })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(t({ amount: '-1' })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(t({ amount: '1.1234567' })).rejects.toThrow(/at most 6 decimals/)
    await expect(t({ symbol: 'EURC' })).rejects.toThrow(/No EURC/)
    await expect(t({ idempotencyKey: 'not-a-uuid' })).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('email OTP always goes to the MeshPort account email', async () => {
    await svc.emailDeviceToken('device-12345678', 'alice@example.com')
    expect(lastCall('/v1/w3s/users/email/token').body).toMatchObject({ email: 'alice@example.com', deviceId: 'device-12345678' })
    await expect(svc.emailDeviceToken('device-12345678', null)).rejects.toMatchObject({ code: 'bad-request' })
  })

  it("never shows another wallet's transaction", async () => {
    await svc.link('uid-alice', ALICE_TOKEN)
    await svc.initialize('uid-alice', ALICE_TOKEN)
    await expect(svc.transaction('uid-alice', ALICE_TOKEN, '66666666-6666-4666-8666-666666666666')).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('checks a session with Circle once, then remembers it for a few minutes', async () => {
    await svc.link('uid-alice', ALICE_TOKEN)
    await svc.initialize('uid-alice', ALICE_TOKEN)
    calls = []
    await svc.balances('uid-alice', ALICE_TOKEN)
    await svc.balances('uid-alice', ALICE_TOKEN)
    expect(calls.filter(c => c.path === '/v1/w3s/user')).toHaveLength(0)
  })

  it('sign requests: message and typed data (bigints as strings)', async () => {
    await svc.link('uid-alice', ALICE_TOKEN)
    await svc.initialize('uid-alice', ALICE_TOKEN)
    await svc.signMessage('uid-alice', ALICE_TOKEN, { message: 'hello' })
    expect(lastCall('/v1/w3s/user/sign/message').body).toEqual({ walletId: ALICE_WALLET, message: 'hello', encodedByHex: false })
    await svc.signTypedData('uid-alice', ALICE_TOKEN, { typedData: { domain: { chainId: 5042002 }, types: { A: [] }, primaryType: 'A', message: { v: 1n } } })
    expect(JSON.parse(lastCall('/v1/w3s/user/sign/typedData').body.data).message.v).toBe('1')
    await expect(svc.signTypedData('uid-alice', ALICE_TOKEN, { typedData: { domain: {} } })).rejects.toMatchObject({ code: 'bad-request' })
  })
})
