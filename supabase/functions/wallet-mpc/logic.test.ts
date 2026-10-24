// supabase/functions/wallet-mpc/logic.test.ts - runs under vitest (pure Web Crypto).
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { keccak256, parseGwei, recoverTransactionAddress, serializeTransaction, toHex } from 'viem'
import { loadMpc, type Mpc } from '../_shared/mpc/wasm.ts'
import {
  BACKUP, PHONE, SERVER, keygenStart, keygenStep, signStart, signStep,
  type Hex, type KeyShare, type KeygenState, type MpcMsg, type PartyNo, type SignState,
} from '../_shared/mpc/protocol.ts'
import { createMpcService, MpcServiceError, STATE_TTL_MS, type MpcRepo, type MpcService } from './logic.ts'

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) // every HTTP body
const rand = (n = 32) => toHex(crypto.getRandomValues(new Uint8Array(n)))

class MemoryRepo implements MpcRepo {
  shares = new Map<string, { address: string; shareCt: string }>()
  log: { authUid: string; hash: Hex; kind: string }[] = []
  async activeShare(uid: string) { return this.shares.get(uid) ?? null }
  async saveShare(uid: string, address: string, shareCt: string) {
    if (this.shares.has(uid)) return 'exists' as const
    this.shares.set(uid, { address, shareCt })
    return 'saved' as const
  }
  async logSign(e: { authUid: string; hash: Hex; kind: string }) { this.log.push(e) }
}

let mpc: Mpc
let clock = Date.now()
let repo: MemoryRepo
let svc: MpcService
const SECRET = crypto.getRandomValues(new Uint8Array(32))

/** The phone's side of signup: it plays the phone and the backup; the server is `svc`. */
async function signup(uid: string): Promise<{ phone: KeyShare; backup: KeyShare; address: Hex }> {
  const begin = json(await svc.keygenBegin(uid))
  const mine = new Map<PartyNo, KeygenState>()
  let fromServer: MpcMsg[] = begin.out
  let local: MpcMsg[] = []
  for (const p of [PHONE, BACKUP] as const) {
    const r = keygenStart(mpc, p, begin.sid)
    mine.set(p, r.state); local.push(...r.out)
  }
  let token = begin.token
  const done = new Map<PartyNo, { share: KeyShare; address: Hex }>()
  for (let round = 1; round <= 3; round++) {
    const toServer = local.filter(m => m.to === SERVER)
    const reply = json(await svc.keygenStep(uid, token, json(toServer)))
    const all = [...local, ...fromServer]
    local = []
    for (const p of [PHONE, BACKUP] as const) {
      const r = keygenStep(mpc, mine.get(p)!, all.filter(m => m.to === p))
      local.push(...r.out)
      if (r.done) done.set(p, r.done); else mine.set(p, r.state)
    }
    if ('address' in reply) {
      expect(round).toBe(3)
      expect(done.get(PHONE)!.address).toBe(reply.address)
      return { phone: done.get(PHONE)!.share, backup: done.get(BACKUP)!.share, address: reply.address }
    }
    token = reply.token
    fromServer = reply.out
  }
  throw new Error('key generation did not finish')
}

/** Phone (or backup) + server sign `hash` in two HTTP calls. */
async function cosign(uid: string, mine: KeyShare, hash: Hex): Promise<{ r: Hex; s: Hex; v: 27 | 28 }> {
  const me = mine.party_index as PartyNo
  const begin = json(await svc.signBegin(uid, { hash, with: me, kind: 'tx', summary: {} }))
  expect(begin.hash).toBe(hash) // the phone refuses if the server would sign anything else
  let st: SignState
  const sent: MpcMsg[] = []
  { const r = signStart(mpc, mine, SERVER, begin.signId, hash); st = r.state; sent.push(...r.out) }
  { const r = signStep(mpc, mine, st, begin.out); st = r.state!; sent.push(...r.out) }
  const reply = json(await svc.signStep(uid, begin.token, json(sent)))
  { const r = signStep(mpc, mine, st, reply.out.filter(m => m.kind === 's2')); st = r.state! }
  const r = signStep(mpc, mine, st, reply.out.filter(m => m.kind === 's3'))
  return r.done!
}

const arcTx = (nonce: number) => ({
  type: 'eip1559' as const, chainId: 5042002, nonce, to: '0x2222222222222222222222222222222222222222' as Hex,
  value: 1n, gas: 21000n, maxFeePerGas: parseGwei('25'), maxPriorityFeePerGas: parseGwei('1'),
})

describe('wallet-mpc service (MeshPort = party 2)', () => {
  let ravi: { phone: KeyShare; backup: KeyShare; address: Hex }

  beforeAll(async () => {
    mpc = await loadMpc(readFileSync(new URL('../../../src/wallet/mpc/meshport_mpc.wasm', import.meta.url)))
    repo = new MemoryRepo()
    svc = await createMpcService({ mpc, repo, secret: SECRET, now: () => clock })
    ravi = await signup('uid-ravi')
  }, 120_000)

  it('signup: phone, backup and server agree on one address; the server stores only a sealed share', () => {
    expect(ravi.address).toMatch(/^0x[0-9a-f]{40}$/)
    const row = repo.shares.get('uid-ravi')!
    expect(row.address).toBe(ravi.address)
    expect(row.shareCt).not.toContain('party_index') // encrypted, not the share JSON
    expect(row.shareCt.length).toBeGreaterThan(100_000)
  })

  it('a second signup for the same account is refused', async () => {
    await expect(svc.keygenBegin('uid-ravi')).rejects.toMatchObject({ code: 'exists' })
  })

  it.each([
    ['phone + server (every day)', 'phone'],
    ['backup + server (new phone)', 'backup'],
  ] as const)('%s signs a real Arc transaction', async (_l, which) => {
    const tx = arcTx(7)
    const sig = await cosign('uid-ravi', ravi[which], keccak256(serializeTransaction(tx)))
    const signed = serializeTransaction(tx, { r: sig.r, s: sig.s, yParity: sig.v - 27 })
    expect((await recoverTransactionAddress({ serializedTransaction: signed })).toLowerCase()).toBe(ravi.address)
    expect(repo.log.at(-1)).toMatchObject({ authUid: 'uid-ravi', kind: 'tx' })
  }, 30_000)

  it("another user's session token is useless", async () => {
    const begin = await svc.signBegin('uid-ravi', { hash: rand(), with: PHONE, kind: 'tx', summary: {} })
    await expect(svc.signStep('uid-mallory', begin.token, [])).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('a tampered or expired session token is refused', async () => {
    const begin = await svc.signBegin('uid-ravi', { hash: rand(), with: PHONE, kind: 'tx', summary: {} })
    const flipped = (begin.token[50] === 'A' ? 'B' : 'A')
    await expect(svc.signStep('uid-ravi', begin.token.slice(0, 50) + flipped + begin.token.slice(51), []))
      .rejects.toMatchObject({ code: 'bad-request' })
    clock += STATE_TTL_MS + 1
    try {
      await expect(svc.signStep('uid-ravi', begin.token, [])).rejects.toMatchObject({ code: 'expired' })
    } finally { clock -= STATE_TTL_MS + 1 }
  })

  it('a keygen token can not be used to sign (and the other way round)', async () => {
    const k = await svc.keygenBegin('uid-new')
    await expect(svc.signStep('uid-new', k.token, [])).rejects.toBeInstanceOf(MpcServiceError)
  })

  it('refuses messages claiming to come from the server itself or an unknown party', async () => {
    const begin = await svc.signBegin('uid-ravi', { hash: rand(), with: PHONE, kind: 'tx', summary: {} })
    const fake = (from: number): MpcMsg => ({ from: from as PartyNo, to: SERVER, kind: 's1', body: {} })
    await expect(svc.signStep('uid-ravi', begin.token, [fake(SERVER)])).rejects.toMatchObject({ code: 'bad-request' })
    await expect(svc.signStep('uid-ravi', begin.token, [fake(7)])).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('refuses to sign without a wallet, without a real hash, or with itself', async () => {
    await expect(svc.signBegin('uid-nobody', { hash: rand(), with: PHONE, kind: 'tx', summary: {} })).rejects.toMatchObject({ code: 'no-wallet' })
    await expect(svc.signBegin('uid-ravi', { hash: '0x1234', with: PHONE, kind: 'tx', summary: {} })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(svc.signBegin('uid-ravi', { hash: rand(), with: SERVER, kind: 'tx', summary: {} })).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('a share sealed for one account does not open for another', async () => {
    repo.shares.set('uid-thief', { ...repo.shares.get('uid-ravi')! })
    await expect(svc.signBegin('uid-thief', { hash: rand(), with: PHONE, kind: 'tx', summary: {} })).rejects.toMatchObject({ code: 'bad-request' })
    repo.shares.delete('uid-thief')
  })
})
