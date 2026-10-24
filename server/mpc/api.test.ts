// End-to-end through api/wallet-mpc.ts itself: real handler, real module,
// the wallet frame's own phone code, Supabase auth + REST replaced by an
// in-memory fake at the fetch boundary.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { keccak256, parseGwei, recoverTransactionAddress, serializeTransaction, type Hex } from 'viem'
import { loadMpc, type Mpc } from '../../src/wallet/mpc/wasm'
import { PHONE, SERVER, type KeyShare } from '../../src/wallet/mpc/protocol'
import { PhoneKeygen, PhoneSign } from '../../src/wallet/mpc/phone'

const URL_ = 'https://fake.supabase.test'
const SESSIONS: Record<string, string> = { 'tok-ravi': 'uid-ravi', 'tok-ana': 'uid-ana', 'tok-anon': 'uid-anon' }
const shares: Array<{ auth_uid: string; address: string; share_ct: string }> = []
const steps = new Set<string>()
const signLog: Array<Record<string, unknown>> = []

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input))
  const ok = (b: unknown, status = 200) => Promise.resolve(new Response(b === null ? null : JSON.stringify(b), { status }))
  const auth = new Headers(init?.headers).get('Authorization') ?? ''
  if (url.pathname === '/auth/v1/user') {
    const uid = SESSIONS[auth.replace(/^Bearer /, '')]
    return uid ? ok({ id: uid, is_anonymous: uid === 'uid-anon' }) : ok({ msg: 'invalid' }, 401)
  }
  expect(auth).toBe('Bearer service-key') // the tables are only ever touched with the service key
  const body = init?.body ? JSON.parse(String(init.body)) : null
  switch (`${init?.method ?? 'GET'} ${url.pathname}`) {
    case 'GET /rest/v1/wallet_mpc_shares': {
      const uid = url.searchParams.get('auth_uid')!.replace(/^eq\./, '')
      expect(url.searchParams.get('revoked_at')).toBe('is.null')
      return ok(shares.filter(s => s.auth_uid === uid).map(({ address, share_ct }) => ({ address, share_ct })))
    }
    case 'POST /rest/v1/wallet_mpc_shares':
      if (shares.some(s => s.auth_uid === body.auth_uid)) return ok({ code: '23505' }, 409)
      shares.push(body)
      return ok(null, 201)
    case 'POST /rest/v1/wallet_mpc_steps': {
      const k = `${body.session_id}|${body.step}`
      if (steps.has(k)) return ok({ code: '23505' }, 409)
      steps.add(k)
      return ok(null, 201)
    }
    case 'POST /rest/v1/wallet_mpc_sign_log':
      signLog.push(body)
      return ok(null, 201)
  }
  return ok({ error: `unexpected ${url.pathname}` }, 500)
}

let handler: (req: any, res: any) => Promise<unknown>
let mpc: Mpc
let identityPub: Hex

async function call(body: unknown, token = 'tok-ravi'): Promise<{ status: number; json: any }> {
  let status = 0, json: unknown
  const res = { status(s: number) { status = s; return res }, json(j: unknown) { json = JSON.parse(JSON.stringify(j)); return res } }
  await handler({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.parse(JSON.stringify(body)) }, res)
  return { status, json }
}

describe('api/wallet-mpc (handler, end to end, with the frame\'s phone code)', () => {
  let phone: KeyShare, address: Hex

  beforeAll(async () => {
    vi.stubEnv('SUPABASE_URL', URL_)
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
    vi.stubEnv('MPC_SECRET', 'ab'.repeat(32))
    vi.stubGlobal('fetch', vi.fn(fakeFetch))
    handler = (await import('../../api/wallet-mpc')).default as typeof handler
    mpc = await loadMpc(readFileSync(new URL('../../src/wallet/mpc/meshport_mpc.wasm', import.meta.url)))
    identityPub = (await call({ action: 'identity' })).json.identityPub
  })
  afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it('rejects anyone not signed in, and anything but POST', async () => {
    expect((await call({ action: 'identity' }, 'tok-nobody')).status).toBe(401)
    let status = 0
    const res = { status(s: number) { status = s; return res }, json() { return res } }
    await handler({ method: 'GET', headers: {} }, res)
    expect(status).toBe(405)
  })

  it('an anonymous session can not create a wallet (its id does not last)', async () => {
    const r = await call({ action: 'keygen-begin', phonePub: new PhoneKeygen(mpc, identityPub).phonePub }, 'tok-anon')
    expect(r.status).toBe(403)
    expect(shares).toHaveLength(0)
  })

  it('signup over HTTP: three requests, only boxes cross the app, a sealed share stored', async () => {
    const k = new PhoneKeygen(mpc, identityPub)
    const begin = await call({ action: 'keygen-begin', phonePub: k.phonePub })
    expect(begin.status).toBe(200)
    expect(Object.keys(begin.json).sort()).toEqual(['box', 'hello', 'sid', 'token']) // no plain protocol messages
    let box = await k.begin(begin.json)
    let token = begin.json.token
    for (let i = 0; i < 4; i++) {
      const reply = await call({ action: 'keygen-step', token, box })
      expect(reply.status).toBe(200)
      if (reply.json.address) { ({ phone, address } = k.finish(reply.json)); break }
      box = await k.next(reply.json)
      token = reply.json.token
    }
    expect(address).toMatch(/^0x[0-9a-f]{40}$/)
    expect(shares).toHaveLength(1)
    expect(shares[0]).toMatchObject({ auth_uid: 'uid-ravi', address })
    expect((await call({ action: 'keygen-begin', phonePub: new PhoneKeygen(mpc, identityPub).phonePub })).status).toBe(409)
  }, 120_000)

  it('pays over HTTP: the server hashes the transaction itself, logs it, and co-signs', async () => {
    const tx = { type: 'eip1559' as const, chainId: 5042002, nonce: 1, to: '0x2222222222222222222222222222222222222222' as Hex, value: 10n, gas: 21000n, maxFeePerGas: parseGwei('25'), maxPriorityFeePerGas: parseGwei('1') }
    const unsigned = serializeTransaction(tx)
    const s = new PhoneSign(mpc, identityPub, phone, keccak256(unsigned))
    const begin = await call({ action: 'sign-begin', with: PHONE, request: { kind: 'tx', tx: unsigned }, phonePub: s.phonePub })
    expect(begin.status).toBe(200)
    expect(begin.json.hash).toBe(keccak256(unsigned))
    expect(begin.json.address).toBe(address)
    expect(signLog.at(-1)).toMatchObject({ auth_uid: 'uid-ravi', kind: 'tx', hash: keccak256(unsigned), summary: { chainId: 5042002, value: '10' } })
    const box = await s.begin(begin.json)
    const step = await call({ action: 'sign-step', token: begin.json.token, box })
    expect(step.status).toBe(200)
    const sig = await s.next(step.json)
    const signed = serializeTransaction(tx, { r: sig.r, s: sig.s, yParity: sig.v - 27 })
    expect((await recoverTransactionAddress({ serializedTransaction: signed })).toLowerCase()).toBe(address)
    // The same request again: refused, the step is spent.
    expect((await call({ action: 'sign-step', token: begin.json.token, box })).status).toBe(409)
  }, 30_000)

  it('maps refusals to HTTP codes', async () => {
    const key = new PhoneKeygen(mpc, identityPub).phonePub
    const mainnet = serializeTransaction({ type: 'eip1559', chainId: 1, nonce: 0, to: '0x2222222222222222222222222222222222222222', value: 1n, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })
    expect((await call({ action: 'sign-begin', with: PHONE, request: { kind: 'tx', tx: mainnet }, phonePub: key })).status).toBe(400)
    expect((await call({ action: 'sign-begin', with: SERVER, request: { kind: 'message', message: 'x' }, phonePub: key })).status).toBe(400)
    expect((await call({ action: 'sign-begin', with: PHONE, request: { kind: 'message', message: 'x' }, phonePub: key }, 'tok-ana')).status).toBe(404) // no wallet
    expect((await call({ action: 'sign-step', token: 'garbage', box: 'x' })).status).toBe(400)
    expect((await call({ action: 'nope' })).status).toBe(400)
  })
})
