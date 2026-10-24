import { describe, it, expect, beforeEach } from 'vitest'
import { createCircleClient, CircleApiError } from './client'
import { circleTransaction, createCircleWalletService, CIRCLE_CHAIN, type CircleLink, type CircleRepo } from './service'

// ── A fake Circle API (fetch level): users, sessions, wallets ───────────────
const API_KEY = 'TEST_API_KEY:abc123:secret456'
const ALICE_TOKEN = 'alice-user-token-' + 'x'.repeat(40)
const BOB_TOKEN = 'bob-user-token-' + 'y'.repeat(40)
const EXPIRED_TOKEN = 'expired-user-token-' + 'z'.repeat(40)
const ALICE_WALLET = '22222222-2222-4222-8222-222222222222'
const ALICE_ARC_WALLET = '88888888-8888-4888-8888-888888888888'
const BOB_WALLET = '33333333-3333-4333-8333-333333333333'

let calls: Array<{ method: string; path: string; headers: Record<string, string>; body: any }>
let initialized: Set<string>
let evmWallets: Set<string>

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
  const challenge = (id: string) => reply(200, { data: { challengeId: id } })
  switch (key) {
    case 'POST /v1/w3s/users/social/token': return reply(200, { data: { deviceToken: 'dt', deviceEncryptionKey: 'dek' } })
    case 'POST /v1/w3s/users/email/token': return reply(200, { data: { deviceToken: 'dt', deviceEncryptionKey: 'dek', otpToken: 'otp' } })
    case 'GET /v1/w3s/user': return user ? reply(200, { data: { id: user, status: 'ENABLED' } }) : reply(401, { code: 401, message: 'no' })
    case 'POST /v1/w3s/user/initialize':
      if (initialized.has(user!)) return reply(409, { code: 155106, message: 'The user has already been initialized' })
      initialized.add(user!); evmWallets.add(user!)
      return challenge('44444444-4444-4444-8444-444444444444')
    case 'POST /v1/w3s/user/wallets':
      evmWallets.add(user!)
      return challenge('66666666-6666-4666-8666-666666666666')
    case 'GET /v1/w3s/wallets': {
      const wallets: unknown[] = []
      // Alice once had an Arc-only wallet (the earlier test); it must never be used for signing.
      if (user === 'circle-alice' && initialized.has(user)) wallets.push({ id: ALICE_ARC_WALLET, address: '0x9999999999999999999999999999999999999999', blockchain: 'ARC-TESTNET', state: 'LIVE', accountType: 'EOA', createDate: '2026-01-01T00:00:00Z' })
      if (evmWallets.has(user!)) wallets.push({ id: user === 'circle-alice' ? ALICE_WALLET : BOB_WALLET, address: user === 'circle-alice' ? '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' : '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', blockchain: CIRCLE_CHAIN, state: 'LIVE', accountType: 'EOA', createDate: '2026-01-02T00:00:00Z' })
      return reply(200, { data: { wallets } })
    }
    case 'POST /v1/w3s/user/sign/transaction':
    case 'POST /v1/w3s/user/sign/message':
    case 'POST /v1/w3s/user/sign/typedData':
      return challenge('55555555-5555-4555-8555-555555555555')
  }
  return reply(404, { code: 404, message: `unexpected ${key}` })
}

class MemoryRepo implements CircleRepo {
  rows = new Map<string, CircleLink>()
  async link(uid: string) { return this.rows.get(uid) ?? null }
  async saveLink(uid: string, circleUserId: string) {
    if ([...this.rows.values()].some(r => r.circleUserId === circleUserId)) return 'taken' as const
    this.rows.set(uid, { circleUserId, walletId: null, address: null, blockchain: null })
    return 'saved' as const
  }
  async saveWallet(uid: string, walletId: string, address: string, blockchain: string) { this.rows.set(uid, { ...this.rows.get(uid)!, walletId, address, blockchain }) }
}

let repo: MemoryRepo
let svc: ReturnType<typeof createCircleWalletService>
const lastCall = (path: string) => [...calls].reverse().find(c => c.path === path)!
const TX = { to: '0x2222222222222222222222222222222222222222', nonce: 3, value: '1000', gas: '21000', maxFeePerGas: '0x5d21dba00', maxPriorityFeePerGas: '1000000000', chainId: 5042002, type: 'eip1559' }

beforeEach(() => {
  calls = []
  initialized = new Set()
  evmWallets = new Set()
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

describe('circleTransaction (what Circle signs)', () => {
  it('EIP-1559 JSON with hex quantities and a numeric chainId', () => {
    expect(JSON.parse(circleTransaction({ ...TX, data: '0xa9059cbb' }))).toEqual({
      to: '0x2222222222222222222222222222222222222222', nonce: '0x3', value: '0x3e8', data: '0xa9059cbb',
      chainId: 5042002, gas: '0x5208', maxFeePerGas: '0x5d21dba00', maxPriorityFeePerGas: '0x3b9aca00',
    })
  })
  it('a legacy gasPrice becomes both EIP-1559 fees', () => {
    const t = JSON.parse(circleTransaction({ to: TX.to, nonce: 0, gas: 21000, gasPrice: '0x10', chainId: 1 }))
    expect(t).toMatchObject({ maxFeePerGas: '0x10', maxPriorityFeePerGas: '0x10', value: '0x0' })
  })
  it('refuses malformed transactions', () => {
    expect(() => circleTransaction(null)).toThrow(/missing/)
    expect(() => circleTransaction({ ...TX, chainId: undefined })).toThrow(/chainId/)
    expect(() => circleTransaction({ ...TX, to: '0x12' })).toThrow(/address/)
    expect(() => circleTransaction({ ...TX, data: 'zz' })).toThrow(/hex/)
    expect(() => circleTransaction({ ...TX, value: '-1' })).toThrow(/non-negative/)
    expect(() => circleTransaction({ ...TX, nonce: undefined })).toThrow(/nonce/)
    expect(() => circleTransaction({ ...TX, type: 'eip4844' })).toThrow(/EIP-1559/)
  })
})

describe('Circle wallet service', () => {
  it('links one MeshPort account to one Circle user, both ways', async () => {
    expect(await svc.link('uid-alice', ALICE_TOKEN)).toEqual({ circleUserId: 'circle-alice' })
    expect(await svc.link('uid-alice', ALICE_TOKEN)).toEqual({ circleUserId: 'circle-alice' }) // again: fine
    await expect(svc.link('uid-mallory', ALICE_TOKEN)).rejects.toMatchObject({ code: 'linked-elsewhere' })
    await expect(svc.link('uid-alice', BOB_TOKEN)).rejects.toMatchObject({ code: 'linked-elsewhere' })
  })

  it("acts only with this account's own Circle session", async () => {
    await svc.link('uid-alice', ALICE_TOKEN)
    await svc.link('uid-bob', BOB_TOKEN)
    await expect(svc.initialize('uid-nobody', ALICE_TOKEN)).rejects.toMatchObject({ code: 'not-linked' })
    await expect(svc.wallet('uid-alice', BOB_TOKEN)).rejects.toMatchObject({ code: 'linked-elsewhere' })
    await expect(svc.wallet('uid-alice', EXPIRED_TOKEN)).rejects.toMatchObject({ code: 'session' })
    await expect(svc.signTransaction('uid-alice', undefined, { transaction: TX })).rejects.toMatchObject({ code: 'session' })
  })

  it('a new user: an initialize challenge for an EVM EOA, then the wallet is found and remembered', async () => {
    await svc.link('uid-bob', BOB_TOKEN)
    await expect(svc.wallet('uid-bob', BOB_TOKEN)).rejects.toMatchObject({ code: 'no-wallet' })
    expect(await svc.initialize('uid-bob', BOB_TOKEN)).toEqual({ challengeId: '44444444-4444-4444-8444-444444444444' })
    expect(lastCall('/v1/w3s/user/initialize').body).toMatchObject({ accountType: 'EOA', blockchains: ['EVM-TESTNET'] })
    expect(await svc.initialize('uid-bob', BOB_TOKEN)).toEqual({ ready: true })
    expect(await svc.wallet('uid-bob', BOB_TOKEN)).toEqual({ walletId: BOB_WALLET, address: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB', blockchain: 'EVM-TESTNET' })
    calls = []
    await svc.wallet('uid-bob', BOB_TOKEN)
    expect(calls.map(c => c.path)).not.toContain('/v1/w3s/wallets') // remembered
  })

  it('a user set up earlier with only an Arc wallet gets the EVM wallet added, and the Arc one is never used', async () => {
    initialized.add('circle-alice') // set up before, Arc-only
    await svc.link('uid-alice', ALICE_TOKEN)
    await repo.saveWallet('uid-alice', ALICE_ARC_WALLET, '0x9999999999999999999999999999999999999999', 'ARC-TESTNET')
    await expect(svc.wallet('uid-alice', ALICE_TOKEN)).rejects.toMatchObject({ code: 'no-wallet' })
    expect(await svc.initialize('uid-alice', ALICE_TOKEN)).toEqual({ challengeId: '66666666-6666-4666-8666-666666666666' })
    expect(lastCall('/v1/w3s/user/wallets').body).toMatchObject({ accountType: 'EOA', blockchains: ['EVM-TESTNET'] })
    expect((await svc.wallet('uid-alice', ALICE_TOKEN)).walletId).toBe(ALICE_WALLET)
    expect(repo.rows.get('uid-alice')).toMatchObject({ walletId: ALICE_WALLET, blockchain: 'EVM-TESTNET' })
  })

  it("sign requests use the account's own wallet; the transaction goes to Circle as JSON", async () => {
    await svc.link('uid-bob', BOB_TOKEN)
    await svc.initialize('uid-bob', BOB_TOKEN)
    await svc.signTransaction('uid-bob', BOB_TOKEN, { transaction: TX })
    const body = lastCall('/v1/w3s/user/sign/transaction').body
    expect(body.walletId).toBe(BOB_WALLET)
    expect(JSON.parse(body.transaction)).toMatchObject({ chainId: 5042002, nonce: '0x3' })
    await svc.signMessage('uid-bob', BOB_TOKEN, { message: 'hello' })
    expect(lastCall('/v1/w3s/user/sign/message').body).toEqual({ walletId: BOB_WALLET, message: 'hello', encodedByHex: false })
    await svc.signTypedData('uid-bob', BOB_TOKEN, { typedData: { domain: { chainId: 5042002 }, types: { A: [] }, primaryType: 'A', message: { v: 1n } } })
    expect(JSON.parse(lastCall('/v1/w3s/user/sign/typedData').body.data).message.v).toBe('1')
    await expect(svc.signTypedData('uid-bob', BOB_TOKEN, { typedData: { domain: {} } })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(svc.signTransaction('uid-bob', BOB_TOKEN, { transaction: { ...TX, to: 'nope' } })).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('email codes always go to the MeshPort account email', async () => {
    await svc.emailDeviceToken('device-12345678', 'alice@example.com')
    expect(lastCall('/v1/w3s/users/email/token').body).toMatchObject({ email: 'alice@example.com', deviceId: 'device-12345678' })
    await expect(svc.emailDeviceToken('device-12345678', null)).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('checks a session with Circle once, then remembers it for a few minutes', async () => {
    await svc.link('uid-bob', BOB_TOKEN)
    await svc.initialize('uid-bob', BOB_TOKEN)
    await svc.wallet('uid-bob', BOB_TOKEN)
    calls = []
    await svc.signMessage('uid-bob', BOB_TOKEN, { message: 'a' })
    await svc.signMessage('uid-bob', BOB_TOKEN, { message: 'b' })
    expect(calls.filter(c => c.path === '/v1/w3s/user')).toHaveLength(0)
  })
})
