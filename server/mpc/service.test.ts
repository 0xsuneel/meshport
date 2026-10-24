// server/mpc/service.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { keccak256, parseGwei, recoverTransactionAddress, serializeTransaction, toHex } from 'viem'
import { loadMpc, type Mpc } from '../../src/wallet/mpc/wasm'
import { PHONE, SERVER, type Hex, type KeyShare } from '../../src/wallet/mpc/protocol'
import { ChannelError } from '../../src/wallet/mpc/channel'
import { PhoneKeygen, PhoneSign } from '../../src/wallet/mpc/phone'
import { createMpcService, STATE_TTL_MS, type MpcRepo, type MpcService } from './service'

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) // every HTTP body
const rand = (n = 32) => toHex(crypto.getRandomValues(new Uint8Array(n)))

class MemoryRepo implements MpcRepo {
  shares = new Map<string, { address: string; shareCt: string }>()
  log: { authUid: string; hash: Hex; kind: string }[] = []
  steps = new Set<string>()
  async activeShare(uid: string) { return this.shares.get(uid) ?? null }
  async saveShare(uid: string, address: string, shareCt: string) {
    if (this.shares.has(uid)) return 'exists' as const
    this.shares.set(uid, { address, shareCt })
    return 'saved' as const
  }
  async consumeStep(sessionId: Hex, step: number) {
    const k = `${sessionId}|${step}`
    if (this.steps.has(k)) return false
    this.steps.add(k)
    return true
  }
  async logSign(e: { authUid: string; hash: Hex; kind: string }) { this.log.push(e) }
}

let mpc: Mpc
let clock = Date.now()
let repo: MemoryRepo
let svc: MpcService
const SECRET = crypto.getRandomValues(new Uint8Array(32))

/** Signup as the wallet frame does it; counts the HTTP requests. */
async function signup(uid: string) {
  const phone = new PhoneKeygen(mpc, svc.identityPub)
  let requests = 1
  const begin = json(await svc.keygenBegin(uid, phone.phonePub))
  let box = await phone.begin(begin)
  let token = begin.token
  for (;;) {
    requests++
    const reply = json(await svc.keygenStep(uid, token, box))
    if ('address' in reply) return { ...phone.finish(reply), requests }
    box = await phone.next(reply)
    token = reply.token
  }
}

/** Phone (or backup) + server sign `hash`, as the frame does it. */
async function cosign(uid: string, share: KeyShare, hash: Hex) {
  const phone = new PhoneSign(mpc, svc.identityPub, share, hash)
  const begin = json(await svc.signBegin(uid, { hash, with: phone.with, kind: 'tx', summary: {} }, phone.phonePub))
  const box = await phone.begin(begin)
  const reply = json(await svc.signStep(uid, begin.token, box))
  return { sig: await phone.next(reply), begin, box, reply }
}

const arcTx = (nonce: number) => ({
  type: 'eip1559' as const, chainId: 5042002, nonce, to: '0x2222222222222222222222222222222222222222' as Hex,
  value: 1n, gas: 21000n, maxFeePerGas: parseGwei('25'), maxPriorityFeePerGas: parseGwei('1'),
})

describe('MPC signing service (MeshPort = party 2) with the wallet frame', () => {
  let ravi: { phone: KeyShare; backup: KeyShare; address: Hex; requests: number }

  beforeAll(async () => {
    mpc = await loadMpc(readFileSync(new URL('../../src/wallet/mpc/meshport_mpc.wasm', import.meta.url)))
    repo = new MemoryRepo()
    svc = await createMpcService({ mpc, repo, secret: SECRET, now: () => clock })
    ravi = await signup('uid-ravi')
  }, 120_000)

  it('signup in three requests: phone, backup and server agree; the server stores only a sealed share', () => {
    expect(ravi.requests).toBe(3)
    expect(ravi.address).toMatch(/^0x[0-9a-f]{40}$/)
    const row = repo.shares.get('uid-ravi')!
    expect(row.address).toBe(ravi.address)
    expect(row.shareCt).not.toContain('party_index') // encrypted, not the share JSON
    expect(row.shareCt.length).toBeGreaterThan(100_000)
  })

  it('a second signup for the same account is refused', async () => {
    await expect(svc.keygenBegin('uid-ravi', new PhoneKeygen(mpc, svc.identityPub).phonePub)).rejects.toMatchObject({ code: 'exists' })
  })

  it.each([
    ['phone + server (every day)', 'phone'],
    ['backup + server (new phone)', 'backup'],
  ] as const)('%s signs a real Arc transaction in two requests', async (_l, which) => {
    const tx = arcTx(7)
    const { sig } = await cosign('uid-ravi', ravi[which], keccak256(serializeTransaction(tx)))
    const signed = serializeTransaction(tx, { r: sig.r, s: sig.s, yParity: sig.v - 27 })
    expect((await recoverTransactionAddress({ serializedTransaction: signed })).toLowerCase()).toBe(ravi.address)
    expect(repo.log.at(-1)).toMatchObject({ authUid: 'uid-ravi', kind: 'tx' })
  }, 30_000)

  it('the same step can not be run twice (no rewinding the server)', async () => {
    const { begin, box } = await cosign('uid-ravi', ravi.phone, rand())
    await expect(svc.signStep('uid-ravi', begin.token, box)).rejects.toMatchObject({ code: 'replayed' })
  })

  it('the frame refuses an impostor server (the app page swapping in its own key)', async () => {
    const impostor = await createMpcService({ mpc, repo: new MemoryRepo(), secret: crypto.getRandomValues(new Uint8Array(32)) })
    const phone = new PhoneKeygen(mpc, svc.identityPub) // pinned: the real server
    const begin = json(await impostor.keygenBegin('uid-x', phone.phonePub))
    await expect(phone.begin(begin)).rejects.toBeInstanceOf(ChannelError)
  })

  it('the frame refuses when the server would sign a different hash', async () => {
    const mine = keccak256(serializeTransaction(arcTx(1)))
    const phone = new PhoneSign(mpc, svc.identityPub, ravi.phone, mine)
    const begin = json(await svc.signBegin('uid-ravi', { hash: rand(), with: PHONE, kind: 'tx', summary: {} }, phone.phonePub))
    await expect(phone.begin(begin)).rejects.toThrow(/something else/)
  })

  it('a box from another session, or a box the app altered, is refused', async () => {
    const hashA = rand(), hashB = rand()
    const a = new PhoneSign(mpc, svc.identityPub, ravi.phone, hashA)
    const b = new PhoneSign(mpc, svc.identityPub, ravi.phone, hashB)
    const beginA = json(await svc.signBegin('uid-ravi', { hash: hashA, with: PHONE, kind: 'tx', summary: {} }, a.phonePub))
    const beginB = json(await svc.signBegin('uid-ravi', { hash: hashB, with: PHONE, kind: 'tx', summary: {} }, b.phonePub))
    await a.begin(beginA)
    const boxB = await b.begin(beginB)
    await expect(svc.signStep('uid-ravi', beginA.token, boxB)).rejects.toMatchObject({ code: 'bad-request' })
    await expect(svc.signStep('uid-ravi', beginB.token, boxB.slice(0, 40) + (boxB[40] === 'A' ? 'B' : 'A') + boxB.slice(41)))
      .rejects.toMatchObject({ code: 'bad-request' })
  })

  it("another user's token, a tampered token and an expired token are refused", async () => {
    const hash = rand()
    const p = new PhoneSign(mpc, svc.identityPub, ravi.phone, hash)
    const begin = json(await svc.signBegin('uid-ravi', { hash, with: PHONE, kind: 'tx', summary: {} }, p.phonePub))
    const box = await p.begin(begin)
    await expect(svc.signStep('uid-mallory', begin.token, box)).rejects.toMatchObject({ code: 'bad-request' })
    const t = begin.token
    await expect(svc.signStep('uid-ravi', t.slice(0, 50) + (t[50] === 'A' ? 'B' : 'A') + t.slice(51), box)).rejects.toMatchObject({ code: 'bad-request' })
    clock += STATE_TTL_MS + 1
    try {
      await expect(svc.signStep('uid-ravi', begin.token, box)).rejects.toMatchObject({ code: 'expired' })
    } finally { clock -= STATE_TTL_MS + 1 }
  })

  it('refuses to sign without a wallet, without a real hash, with itself, or without a session key', async () => {
    const key = new PhoneSign(mpc, svc.identityPub, ravi.phone, rand()).phonePub
    await expect(svc.signBegin('uid-nobody', { hash: rand(), with: PHONE, kind: 'tx', summary: {} }, key)).rejects.toMatchObject({ code: 'no-wallet' })
    await expect(svc.signBegin('uid-ravi', { hash: '0x1234', with: PHONE, kind: 'tx', summary: {} }, key)).rejects.toMatchObject({ code: 'bad-request' })
    await expect(svc.signBegin('uid-ravi', { hash: rand(), with: SERVER, kind: 'tx', summary: {} }, key)).rejects.toMatchObject({ code: 'bad-request' })
    await expect(svc.signBegin('uid-ravi', { hash: rand(), with: PHONE, kind: 'tx', summary: {} }, '0x1234')).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('a share sealed for one account does not open for another', async () => {
    repo.shares.set('uid-thief', { ...repo.shares.get('uid-ravi')! })
    const key = new PhoneSign(mpc, svc.identityPub, ravi.phone, rand()).phonePub
    await expect(svc.signBegin('uid-thief', { hash: rand(), with: PHONE, kind: 'tx', summary: {} }, key)).rejects.toMatchObject({ code: 'bad-request' })
    repo.shares.delete('uid-thief')
  })
})
