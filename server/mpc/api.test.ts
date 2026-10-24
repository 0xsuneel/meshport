// End-to-end through api/wallet-mpc.ts itself: real handler, real module,
// Supabase auth + REST replaced by an in-memory fake at the fetch boundary.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { keccak256, parseGwei, recoverTransactionAddress, serializeTransaction, type Hex } from 'viem'
import { loadMpc, type Mpc } from '../../src/wallet/mpc/wasm'
import {
  BACKUP, PHONE, SERVER, keygenStart, keygenStep, signStart, signStep,
  type KeyShare, type KeygenState, type MpcMsg, type PartyNo, type SignState,
} from '../../src/wallet/mpc/protocol'

const URL_ = 'https://fake.supabase.test'
const SESSIONS: Record<string, string> = { 'tok-ravi': 'uid-ravi', 'tok-ana': 'uid-ana' }
const shares: Array<{ auth_uid: string; address: string; share_ct: string; revoked_at: null }> = []
const signLog: Array<Record<string, unknown>> = []

function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input))
  const ok = (b: unknown, status = 200) => Promise.resolve(new Response(b === null ? null : JSON.stringify(b), { status }))
  const auth = new Headers(init?.headers).get('Authorization') ?? ''
  if (url.pathname === '/auth/v1/user') {
    const uid = SESSIONS[auth.replace(/^Bearer /, '')]
    return uid ? ok({ id: uid }) : ok({ msg: 'invalid' }, 401)
  }
  expect(auth).toBe('Bearer service-key') // the table is only ever touched with the service key
  if (url.pathname === '/rest/v1/wallet_mpc_shares' && (init?.method ?? 'GET') === 'GET') {
    const uid = url.searchParams.get('auth_uid')!.replace(/^eq\./, '')
    expect(url.searchParams.get('revoked_at')).toBe('is.null')
    return ok(shares.filter(s => s.auth_uid === uid).map(({ address, share_ct }) => ({ address, share_ct })))
  }
  if (url.pathname === '/rest/v1/wallet_mpc_shares' && init?.method === 'POST') {
    const row = JSON.parse(String(init.body))
    if (shares.some(s => s.auth_uid === row.auth_uid)) return ok({ code: '23505' }, 409)
    shares.push({ ...row, revoked_at: null })
    return ok(null, 201)
  }
  if (url.pathname === '/rest/v1/wallet_mpc_sign_log' && init?.method === 'POST') {
    signLog.push(JSON.parse(String(init.body)))
    return ok(null, 201)
  }
  return ok({ error: `unexpected ${url.pathname}` }, 500)
}

let handler: (req: any, res: any) => Promise<unknown>
let mpc: Mpc

async function call(body: unknown, token = 'tok-ravi'): Promise<{ status: number; json: any }> {
  let status = 0, json: unknown
  const res = { status(s: number) { status = s; return res }, json(j: unknown) { json = JSON.parse(JSON.stringify(j)); return res } }
  await handler({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.parse(JSON.stringify(body)) }, res)
  return { status, json }
}

describe('api/wallet-mpc (handler, end to end)', () => {
  let phone: KeyShare, address: Hex

  beforeAll(async () => {
    vi.stubEnv('SUPABASE_URL', URL_)
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
    vi.stubEnv('MPC_SECRET', 'ab'.repeat(32))
    vi.stubGlobal('fetch', vi.fn(fakeFetch))
    handler = (await import('../../api/wallet-mpc')).default as typeof handler
    mpc = await loadMpc(readFileSync(new URL('../../src/wallet/mpc/meshport_mpc.wasm', import.meta.url)))
  })
  afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it('rejects anyone not signed in, and anything but POST', async () => {
    expect((await call({ action: 'keygen-begin' }, 'tok-nobody')).status).toBe(401)
    let status = 0
    const res = { status(s: number) { status = s; return res }, json() { return res } }
    await handler({ method: 'GET', headers: {} }, res)
    expect(status).toBe(405)
  })

  it('signup over HTTP: four requests, one shared address, a sealed share stored', async () => {
    const begin = await call({ action: 'keygen-begin' })
    expect(begin.status).toBe(200)
    const mine = new Map<PartyNo, KeygenState>()
    let local: MpcMsg[] = []
    for (const p of [PHONE, BACKUP] as const) { const r = keygenStart(mpc, p, begin.json.sid); mine.set(p, r.state); local.push(...r.out) }
    let token = begin.json.token, fromServer: MpcMsg[] = begin.json.out
    const done = new Map<PartyNo, KeyShare>()
    for (let round = 1; round <= 3; round++) {
      const reply = await call({ action: 'keygen-step', token, msgs: local.filter(m => m.to === SERVER) })
      expect(reply.status).toBe(200)
      const all = [...local, ...fromServer]; local = []
      for (const p of [PHONE, BACKUP] as const) {
        const r = keygenStep(mpc, mine.get(p)!, all.filter(m => m.to === p))
        local.push(...r.out)
        if (r.done) { done.set(p, r.done.share); expect(r.done.address).toBe(reply.json.address) } // phone and server agree
        else mine.set(p, r.state)
      }
      if (reply.json.address) { address = reply.json.address; break }
      token = reply.json.token; fromServer = reply.json.out
    }
    phone = done.get(PHONE)!
    expect(address).toMatch(/^0x[0-9a-f]{40}$/)
    expect(shares).toHaveLength(1)
    expect(shares[0]).toMatchObject({ auth_uid: 'uid-ravi', address })
    expect((await call({ action: 'keygen-begin' })).status).toBe(409) // one wallet per account
  }, 120_000)

  it('pays over HTTP: the server hashes the transaction itself, logs it, and co-signs', async () => {
    const tx = { type: 'eip1559' as const, chainId: 5042002, nonce: 1, to: '0x2222222222222222222222222222222222222222' as Hex, value: 10n, gas: 21000n, maxFeePerGas: parseGwei('25'), maxPriorityFeePerGas: parseGwei('1') }
    const unsigned = serializeTransaction(tx)
    const begin = await call({ action: 'sign-begin', with: PHONE, request: { kind: 'tx', tx: unsigned } })
    expect(begin.status).toBe(200)
    expect(begin.json.hash).toBe(keccak256(unsigned))
    expect(begin.json.address).toBe(address)
    expect(signLog.at(-1)).toMatchObject({ auth_uid: 'uid-ravi', kind: 'tx', hash: keccak256(unsigned), summary: { chainId: 5042002, value: '10' } })

    let st: SignState
    const sent: MpcMsg[] = []
    { const r = signStart(mpc, phone, SERVER, begin.json.signId, begin.json.hash); st = r.state; sent.push(...r.out) }
    { const r = signStep(mpc, phone, st, begin.json.out); st = r.state!; sent.push(...r.out) }
    const step = await call({ action: 'sign-step', token: begin.json.token, msgs: sent })
    expect(step.status).toBe(200)
    { const r = signStep(mpc, phone, st, step.json.out.filter((m: MpcMsg) => m.kind === 's2')); st = r.state! }
    const sig = signStep(mpc, phone, st, step.json.out.filter((m: MpcMsg) => m.kind === 's3')).done!
    const signed = serializeTransaction(tx, { r: sig.r, s: sig.s, yParity: sig.v - 27 })
    expect((await recoverTransactionAddress({ serializedTransaction: signed })).toLowerCase()).toBe(address)
  }, 30_000)

  it('maps refusals to HTTP codes', async () => {
    const mainnet = serializeTransaction({ type: 'eip1559', chainId: 1, nonce: 0, to: '0x2222222222222222222222222222222222222222', value: 1n, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })
    expect((await call({ action: 'sign-begin', with: PHONE, request: { kind: 'tx', tx: mainnet } })).status).toBe(400)
    expect((await call({ action: 'sign-begin', with: SERVER, request: { kind: 'message', message: 'x' } })).status).toBe(400)
    expect((await call({ action: 'sign-begin', with: PHONE, request: { kind: 'message', message: 'x' } }, 'tok-ana')).status).toBe(404) // no wallet
    expect((await call({ action: 'sign-step', token: 'garbage', msgs: [] })).status).toBe(400)
    expect((await call({ action: 'nope' })).status).toBe(400)
  })
})
