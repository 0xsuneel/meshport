// End-to-end through api/circle-wallet.ts: real handler, Supabase auth + REST
// and Circle's API faked at the fetch boundary.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const SUPA = 'https://fake.supabase.test'
const API_KEY = 'TEST_API_KEY:abc123:secret456'
const SESSIONS: Record<string, { id: string; email: string; is_anonymous?: boolean }> = {
  'tok-alice': { id: 'uid-alice', email: 'alice@example.com' },
  'tok-mallory': { id: 'uid-mallory', email: 'mallory@example.com' },
  'tok-anon': { id: 'uid-anon', email: '', is_anonymous: true },
}
const ALICE_CIRCLE = 'alice-circle-token-' + 'x'.repeat(40)
const WALLET = '22222222-2222-4222-8222-222222222222'
const USDC = '11111111-1111-4111-8111-111111111111'
const rows: Array<{ auth_uid: string; circle_user_id: string; wallet_id: string | null; address: string | null }> = []
const circleBodies: Record<string, any> = {}
let initialized = false

function fake(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input))
  const h = new Headers(init?.headers)
  const method = init?.method ?? 'GET'
  const body = init?.body ? JSON.parse(String(init.body)) : null
  const ok = (j: unknown, status = 200) => Promise.resolve(new Response(j === null ? null : JSON.stringify(j), { status }))
  if (url.origin === SUPA) {
    if (url.pathname === '/auth/v1/user') {
      const s = SESSIONS[(h.get('Authorization') ?? '').replace('Bearer ', '')]
      return s ? ok(s) : ok({ msg: 'no' }, 401)
    }
    expect(h.get('Authorization')).toBe('Bearer service-key')
    const uid = url.searchParams.get('auth_uid')?.replace(/^eq\./, '')
    if (url.pathname === '/rest/v1/circle_wallet_users') {
      if (method === 'GET') return ok(rows.filter(r => r.auth_uid === uid).map(({ circle_user_id, wallet_id, address }) => ({ circle_user_id, wallet_id, address })))
      if (method === 'POST') {
        if (rows.some(r => r.auth_uid === body.auth_uid || r.circle_user_id === body.circle_user_id)) return ok({ code: '23505' }, 409)
        rows.push({ auth_uid: body.auth_uid, circle_user_id: body.circle_user_id, wallet_id: null, address: null })
        return ok(null, 201)
      }
      if (method === 'PATCH') { Object.assign(rows.find(r => r.auth_uid === uid)!, { wallet_id: body.wallet_id, address: body.address }); return ok(null, 204) }
    }
    return ok({ error: 'unexpected supabase call' }, 500)
  }
  // Circle
  expect(h.get('Authorization')).toBe(`Bearer ${API_KEY}`)
  circleBodies[`${method} ${url.pathname}`] = body
  const user = h.get('X-User-Token') === ALICE_CIRCLE ? 'circle-alice' : null
  switch (`${method} ${url.pathname}`) {
    case 'POST /v1/w3s/users/email/token': return ok({ data: { deviceToken: 'dt', deviceEncryptionKey: 'dek', otpToken: 'otp' } })
    case 'GET /v1/w3s/user': return user ? ok({ data: { id: user, status: 'ENABLED' } }) : ok({ code: 155104, message: 'The user token has expired' }, 403)
    case 'POST /v1/w3s/user/initialize': initialized = true; return ok({ data: { challengeId: '44444444-4444-4444-8444-444444444444' } })
    case 'GET /v1/w3s/wallets': return ok({ data: { wallets: initialized ? [{ id: WALLET, address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', blockchain: 'ARC-TESTNET', state: 'LIVE', accountType: 'EOA', createDate: '2026-01-01T00:00:00Z' }] : [] } })
    case `GET /v1/w3s/wallets/${WALLET}/balances`: return ok({ data: { tokenBalances: [{ amount: '5', token: { id: USDC, symbol: 'USDC', isNative: true, decimals: 6 } }] } })
    case 'POST /v1/w3s/user/transactions/transfer': return ok({ data: { challengeId: '55555555-5555-4555-8555-555555555555' } })
  }
  return ok({ code: 404, message: 'unexpected circle call' }, 404)
}

let handler: (req: any, res: any) => Promise<unknown>
async function call(body: unknown, token = 'tok-alice') {
  let status = 0, json: any
  const res = { status(s: number) { status = s; return res }, json(j: unknown) { json = JSON.parse(JSON.stringify(j)); return res } }
  await handler({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.parse(JSON.stringify(body)) }, res)
  return { status, json }
}

describe('api/circle-wallet (handler, end to end)', () => {
  beforeAll(async () => {
    vi.stubEnv('SUPABASE_URL', SUPA)
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
    vi.stubEnv('CIRCLE_API_KEY', API_KEY)
    vi.stubGlobal('fetch', vi.fn(fake))
    handler = (await import('../../api/circle-wallet')).default as typeof handler
  })
  afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it('needs a real MeshPort sign-in: none → 401, anonymous → 403, GET → 405', async () => {
    expect((await call({ action: 'link' }, 'tok-nobody')).status).toBe(401)
    expect((await call({ action: 'link' }, 'tok-anon')).status).toBe(403)
    let status = 0
    const res = { status(s: number) { status = s; return res }, json() { return res } }
    await handler({ method: 'GET', headers: {} }, res)
    expect(status).toBe(405)
  })

  it('email OTP goes to the signed-in account email, whatever the request says', async () => {
    const r = await call({ action: 'email-device-token', deviceId: 'device-12345678', email: 'attacker@evil.test' })
    expect(r.status).toBe(200)
    expect(circleBodies['POST /v1/w3s/users/email/token'].email).toBe('alice@example.com')
  })

  it('link → initialize → wallet → balances → transfer, through Supabase and Circle', async () => {
    expect((await call({ action: 'link', userToken: ALICE_CIRCLE })).json).toMatchObject({ circleUserId: 'circle-alice' })
    expect(rows).toEqual([{ auth_uid: 'uid-alice', circle_user_id: 'circle-alice', wallet_id: null, address: null }])
    expect((await call({ action: 'initialize', userToken: ALICE_CIRCLE })).json).toEqual({ challengeId: '44444444-4444-4444-8444-444444444444' })
    expect((await call({ action: 'wallet', userToken: ALICE_CIRCLE })).json).toMatchObject({ walletId: WALLET, blockchain: 'ARC-TESTNET' })
    expect(rows[0].wallet_id).toBe(WALLET)
    expect((await call({ action: 'balances', userToken: ALICE_CIRCLE })).json.balances[0]).toMatchObject({ symbol: 'USDC', amount: '5' })
    const tr = await call({ action: 'transfer', userToken: ALICE_CIRCLE, to: '0x2222222222222222222222222222222222222222', amount: '1.5', walletId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })
    expect(tr.status).toBe(200)
    expect(circleBodies['POST /v1/w3s/user/transactions/transfer'].walletId).toBe(WALLET) // the client's walletId is ignored
  })

  it('maps refusals to HTTP codes', async () => {
    expect((await call({ action: 'link', userToken: ALICE_CIRCLE }, 'tok-mallory')).status).toBe(409) // Alice's Circle, Mallory's account
    expect((await call({ action: 'balances', userToken: 'expired-token-' + 'z'.repeat(40) })).json.code).toBe('session')
    expect((await call({ action: 'transfer', userToken: ALICE_CIRCLE, to: 'nope', amount: '1' })).status).toBe(400)
    expect((await call({ action: 'wallet', userToken: ALICE_CIRCLE }, 'tok-mallory')).json.code).toBe('not-linked') // Mallory has no Circle link to act through
    expect((await call({ action: 'nope' })).status).toBe(400)
  })
})
