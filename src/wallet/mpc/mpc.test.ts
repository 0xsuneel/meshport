import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { keccak256, parseGwei, recoverTransactionAddress, serializeTransaction, toBytes, toHex, type Hex } from 'viem'
import { loadMpc, MpcError, type Mpc } from './wasm'
import {
  BACKUP, PARTIES, PHONE, SERVER, keygenStart, keygenStep, shareAddress, signStart, signStep,
  type KeyShare, type KeygenState, type MpcMsg, type PartyNo, type SignState,
} from './protocol'

const WASM = new URL('./meshport_mpc.wasm', import.meta.url)
// Every state crosses a JSON round-trip, as the server's sealed state will.
const viaJson = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const rand = (n = 32) => toHex(crypto.getRandomValues(new Uint8Array(n)))

let mpc: Mpc
let shares: Record<PartyNo, KeyShare>
let address: Hex

function keygen(): { shares: Record<PartyNo, KeyShare>; address: Hex } {
  const sid = rand()
  let states = new Map<PartyNo, KeygenState>()
  let mail: MpcMsg[] = []
  for (const p of PARTIES) {
    const r = keygenStart(mpc, p, sid)
    states.set(p, viaJson(r.state))
    mail.push(...viaJson(r.out))
  }
  const done = new Map<PartyNo, { share: KeyShare; address: Hex }>()
  while (done.size < PARTIES.length) {
    const next = new Map<PartyNo, KeygenState>()
    const nextMail: MpcMsg[] = []
    for (const [p, st] of states) {
      const r = keygenStep(mpc, st, mail.filter(m => m.to === p))
      nextMail.push(...viaJson(r.out))
      if (r.done) done.set(p, viaJson(r.done))
      else next.set(p, viaJson(r.state))
    }
    states = next
    mail = nextMail
  }
  const addresses = new Set([...done.values()].map(d => d.address))
  expect(addresses.size).toBe(1)
  return {
    shares: Object.fromEntries([...done].map(([p, d]) => [p, d.share])) as Record<PartyNo, KeyShare>,
    address: [...addresses][0],
  }
}

function sign(a: PartyNo, b: PartyNo, hash: Hex): { r: Hex; s: Hex; v: 27 | 28 } {
  const signId = rand()
  const st = new Map<PartyNo, SignState>()
  let mail: MpcMsg[] = []
  for (const [me, other] of [[a, b], [b, a]] as const) {
    const r = signStart(mpc, shares[me], other, signId, hash)
    st.set(me, viaJson(r.state))
    mail.push(...viaJson(r.out))
  }
  const sigs: { r: Hex; s: Hex; v: 27 | 28 }[] = []
  while (sigs.length < 2) {
    const next: MpcMsg[] = []
    for (const [me, s] of [...st]) {
      const r = signStep(mpc, shares[me], s, mail.filter(m => m.to === me))
      next.push(...viaJson(r.out))
      if (r.done) { sigs.push(r.done); st.delete(me) } else st.set(me, viaJson(r.state))
    }
    mail = next
  }
  expect(sigs[0]).toEqual(sigs[1]) // both signers end with the same signature
  return sigs[0]
}

describe('MPC wallet module (DKLs23 2-of-3, WebAssembly)', () => {
  beforeAll(async () => {
    const bytes = readFileSync(WASM)
    const want = readFileSync(new URL('./meshport_mpc.wasm.sha256', import.meta.url), 'utf8').trim()
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(want) // committed .wasm matches its hash
    mpc = await loadMpc(bytes)
    ;({ shares, address } = keygen())
  }, 120_000)

  it('creates one wallet address shared by phone, server and backup', () => {
    expect(address).toMatch(/^0x[0-9a-f]{40}$/)
    for (const p of PARTIES) {
      expect(shares[p].party_index).toBe(p)
      expect(shareAddress(mpc, shares[p])).toBe(address)
    }
  })

  it.each([
    ['phone + server (every day)', PHONE, SERVER],
    ['server + backup (new phone)', SERVER, BACKUP],
    ['phone + backup (server down)', PHONE, BACKUP],
  ] as const)('signs a real Arc transaction: %s', async (_label, a, b) => {
    const tx = {
      type: 'eip1559' as const, chainId: 5042002, nonce: 0,
      to: '0x2222222222222222222222222222222222222222' as Hex, value: 1n, gas: 21000n,
      maxFeePerGas: parseGwei('25'), maxPriorityFeePerGas: parseGwei('1'),
    }
    const hash = keccak256(serializeTransaction(tx))
    const sig = sign(a, b, hash)
    const signed = serializeTransaction(tx, { r: sig.r, s: sig.s, yParity: sig.v - 27 })
    expect((await recoverTransactionAddress({ serializedTransaction: signed })).toLowerCase()).toBe(address)
    // Low-s, as Ethereum requires.
    expect(BigInt(sig.s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n).toBe(true)
  }, 30_000)

  it('a signature is only valid for the hash that was signed', async () => {
    const hash = keccak256(toBytes('pay 10 USDC to Ana'))
    const sig = sign(PHONE, SERVER, hash)
    const { recoverAddress } = await import('viem')
    const other = keccak256(toBytes('pay 1000 USDC to Mallory'))
    expect((await recoverAddress({ hash, signature: { r: sig.r, s: sig.s, v: BigInt(sig.v) } })).toLowerCase()).toBe(address)
    expect((await recoverAddress({ hash: other, signature: { r: sig.r, s: sig.s, v: BigInt(sig.v) } })).toLowerCase()).not.toBe(address)
  })

  it('refuses bad input instead of signing', () => {
    const hash = keccak256(toBytes('x'))
    expect(() => signStart(mpc, shares[PHONE], PHONE, rand(), hash)).toThrow(MpcError)         // with itself
    expect(() => signStart(mpc, shares[PHONE], SERVER, '0x1234', hash)).toThrow(/sign id/)      // short sign id
    expect(() => signStart(mpc, shares[PHONE], SERVER, rand(), '0x12')).toThrow(/32 bytes/)      // not a hash
    expect(() => keygenStart(mpc, 4 as PartyNo, rand())).toThrow(/out of range/)
    // A step without the other party's message fails loudly.
    const { state } = signStart(mpc, shares[PHONE], SERVER, rand(), hash)
    expect(() => signStep(mpc, shares[PHONE], state, [])).toThrow(/missing s1 from party 2/)
  })
})
