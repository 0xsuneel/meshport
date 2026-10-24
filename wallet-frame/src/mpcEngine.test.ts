// The whole MPC client path: app driver (src/wallet/mpcClient.ts) → frame
// engine (this folder) ↔ MeshPort's service (server/mpc), as main.ts and
// api/wallet-mpc.ts wire them, with every hop a JSON round-trip.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  keccak256, parseGwei, recoverMessageAddress, recoverTransactionAddress, recoverTypedDataAddress,
  serializeTransaction, type Hex,
} from 'viem'
import { loadMpc, type Mpc } from '@/wallet/mpc/wasm'
import type { KeyShare } from '@/wallet/mpc/protocol'
import { mpcSign, mpcSignup, type MpcFrame, type MpcPost } from '@/wallet/mpcClient'
import { createMpcService, type MpcService } from '../../server/mpc/service'
import { hashSignRequest } from '../../server/mpc/requests'
import { createMpcEngine, MPC_SESSION_TTL_MS, MpcEngineError, type MpcEngine } from './mpcEngine'

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v))
let mpc: Mpc
let svc: MpcService
let engine: MpcEngine
let clock = Date.now()
const shares = new Map<string, { phone: KeyShare; backup: KeyShare }>() // the frame's vault, in memory
let storeFails = false // a phone whose storage refuses the shares
let uid = 'uid-ravi'
const stored = new Map<string, { address: string; shareCt: string }>() // the server's table

// main.ts: frame requests over the engine, with storage.
const frame: MpcFrame = {
  keygenBegin: async () => json(await engine.keygenBegin()),
  async keygenNext(session, reply) {
    const r = await engine.keygenNext(session, json(reply) as any)
    if (r.shares) {
      // Stored before this box goes out, as main.ts does.
      if (storeFails) throw new Error("This browser couldn't save the wallet")
      shares.set(r.shares.address, { phone: r.shares.phone, backup: r.shares.backup })
    }
    return { box: r.box } // shares never leave the frame
  },
  keygenFinish: async (session, address) => json(await engine.keygenFinish(session, address)),
  async signBegin(address, request) {
    const s = shares.get(address.toLowerCase())
    if (!s) throw new Error('no MPC wallet here')
    return json(await engine.signBegin(s.phone, json(request)))
  },
  signNext: async (session, reply) => json(await engine.signNext(session, json(reply) as any)),
}

// api/wallet-mpc.ts: the HTTP actions over the service, for one signed-in user.
const post: MpcPost = async (body) => {
  const b = json(body) as any
  switch (b.action) {
    case 'keygen-begin': return json(await svc.keygenBegin(uid, b.phonePub))
    case 'keygen-step': return json(await svc.keygenStep(uid, b.token, b.box))
    case 'sign-begin': return json(await svc.signBegin(uid, { ...hashSignRequest(b.request), with: b.with }, b.phonePub))
    case 'sign-step': return json(await svc.signStep(uid, b.token, b.box))
  }
  throw new Error('unknown action')
}

describe('MPC wallet: app driver + frame engine + signing service', () => {
  let address: Hex

  beforeAll(async () => {
    mpc = await loadMpc(readFileSync(new URL('../../src/wallet/mpc/meshport_mpc.wasm', import.meta.url)))
    const steps = new Set<string>()
    svc = await createMpcService({
      mpc, secret: crypto.getRandomValues(new Uint8Array(32)), now: () => clock,
      repo: {
        activeShare: async u => stored.get(u) ?? null,
        saveShare: async (u, a, c) => (stored.has(u) ? 'exists' : (stored.set(u, { address: a, shareCt: c }), 'saved')),
        consumeStep: async (s, n) => (steps.has(`${s}|${n}`) ? false : (steps.add(`${s}|${n}`), true)),
        logSign: async () => {},
      },
    })
    engine = createMpcEngine({ mpc: async () => mpc, identityPub: svc.identityPub, now: () => clock })
    address = await mpcSignup(frame, post)
  }, 120_000)

  it('if the phone can not store its shares, signup stops before the server saves its share', async () => {
    uid = 'uid-full-storage'
    storeFails = true
    try {
      await expect(mpcSignup(frame, post)).rejects.toThrow(/couldn't save/)
      expect(stored.has('uid-full-storage')).toBe(false) // no orphaned server share
    } finally { storeFails = false; uid = 'uid-ravi' }
  }, 120_000)

  it('signup leaves the phone share and the backup share in the frame', () => {
    expect(address).toMatch(/^0x[0-9a-f]{40}$/)
    const s = shares.get(address)!
    expect(s.phone.party_index).toBe(1)
    expect(s.backup.party_index).toBe(3)
  })

  it('signs a real Arc transaction', async () => {
    const tx = { type: 'eip1559' as const, chainId: 5042002, nonce: 0, to: '0x2222222222222222222222222222222222222222' as Hex, value: 5n, gas: 21000n, maxFeePerGas: parseGwei('25'), maxPriorityFeePerGas: parseGwei('1') }
    const sig = await mpcSign(frame, post, address, { kind: 'tx', tx: serializeTransaction(tx) })
    const signed = serializeTransaction(tx, { r: sig.r, s: sig.s, yParity: sig.v - 27 })
    expect((await recoverTransactionAddress({ serializedTransaction: signed })).toLowerCase()).toBe(address)
  }, 30_000)

  it('signs a message (personal_sign)', async () => {
    const sig = await mpcSign(frame, post, address, { kind: 'message', message: 'MeshPort login' })
    const signature = `${sig.r}${sig.s.slice(2)}${sig.v.toString(16)}` as Hex
    expect((await recoverMessageAddress({ message: 'MeshPort login', signature })).toLowerCase()).toBe(address)
  }, 30_000)

  it('signs EIP-712 typed data (a USDC permit on Arc testnet)', async () => {
    const typedData = {
      domain: { name: 'USDC', version: '2', chainId: 5042002, verifyingContract: '0x3600000000000000000000000000000000000000' as Hex },
      types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      primaryType: 'Permit' as const,
      message: { owner: address, spender: '0x4444444444444444444444444444444444444444' as Hex, value: '1000000', nonce: '0', deadline: '9999999999' },
    }
    const sig = await mpcSign(frame, post, address, { kind: 'typed', typedData })
    const signature = `${sig.r}${sig.s.slice(2)}${sig.v.toString(16)}` as Hex
    expect((await recoverTypedDataAddress({ ...typedData, signature } as any)).toLowerCase()).toBe(address)
  }, 30_000)

  it('the frame refuses a signed transaction, and an unconfigured frame refuses everything', async () => {
    const tx = { type: 'eip1559' as const, chainId: 5042002, nonce: 0, to: '0x2222222222222222222222222222222222222222' as Hex, value: 1n, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }
    const signed = serializeTransaction(tx, { r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}`, yParity: 0 })
    await expect(engine.signBegin(shares.get(address)!.phone, { kind: 'tx', tx: signed })).rejects.toThrow(/unsigned/)
    const bare = createMpcEngine({ mpc: async () => mpc, identityPub: undefined })
    await expect(bare.keygenBegin()).rejects.toBeInstanceOf(MpcEngineError)
  })

  it('a session expires, and a failed step ends the session for good', async () => {
    const { session } = await engine.signBegin(shares.get(address)!.phone, { kind: 'message', message: 'x' })
    clock += MPC_SESSION_TTL_MS + 1
    try {
      await expect(engine.signNext(session, { box: '' })).rejects.toThrow(/expired/)
    } finally { clock -= MPC_SESSION_TTL_MS + 1 }

    const b = await engine.signBegin(shares.get(address)!.phone, { kind: 'message', message: 'y' })
    await expect(engine.signNext(b.session, { box: 'not a reply' })).rejects.toBeInstanceOf(MpcEngineError)
    await expect(engine.signNext(b.session, { box: 'again' })).rejects.toThrow(/expired/) // gone, not resumable
  })

  it('the hash the frame signs is computed by the frame, not taken from the app', async () => {
    const tx = serializeTransaction({ type: 'eip1559', chainId: 5042002, nonce: 9, to: '0x2222222222222222222222222222222222222222', value: 1n, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })
    const b = await engine.signBegin(shares.get(address)!.phone, { kind: 'tx', tx })
    expect(b.hash).toBe(keccak256(tx))
  })
})
