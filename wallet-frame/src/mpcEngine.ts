// wallet-frame/src/mpcEngine.ts
//
// The frame's MPC work, with no storage and no messaging: open sessions for
// signup and signing, as the app drives them (src/wallet/mpcClient.ts). Runs
// inside a Web Worker (mpcWorker.ts) so key generation - seconds of CPU on a
// phone - never blocks the frame or the app.
//
// The frame hashes what it is asked to sign itself; the signing service does
// the same, and PhoneSign refuses if the two disagree.

import { hashMessage, hashTypedData, keccak256, parseTransaction } from 'viem'
import { PhoneKeygen, PhoneSign, type KeygenOffload, type ServerHello } from '@/wallet/mpc/phone'
import { PARTIES, keygenStart, keygenStep, type EcdsaSig, type Hex, type KeygenState, type KeyShare, type MpcMsg, type PartyNo } from '@/wallet/mpc/protocol'
import type { Mpc } from '@/wallet/mpc/wasm'
import type { MpcSignRequest } from '@/wallet/protocol'

export type { MpcSignRequest }

export const MPC_SESSION_TTL_MS = 5 * 60_000


export class MpcEngineError extends Error {}

/** The 32-byte hash a request is signed as - the same rule the server uses. */
export function hashRequest(r: MpcSignRequest): Hex {
  if (r.kind === 'tx') {
    const tx = parseTransaction(r.tx)
    if (tx.r || tx.s) throw new MpcEngineError('Send the unsigned transaction')
    return keccak256(r.tx)
  }
  if (r.kind === 'message') return hashMessage(r.message)
  if (r.kind === 'typed') return hashTypedData(r.typedData as Parameters<typeof hashTypedData>[0])
  throw new MpcEngineError('Unknown request kind')
}

export interface MpcEngine {
  keygenBegin(): Promise<{ session: string; phonePub: Hex }>
  /** keygen-begin's reply, then each keygen-step reply that has a box. */
  /**
   * The step where the phone finishes also returns its shares, to be stored
   * before that box is sent - so a failed store stops signup before the
   * server saves its share.
   */
  keygenNext(session: string, reply: { sid?: Hex; hello?: ServerHello; box: string }): Promise<{ box: string; shares?: { address: Hex; phone: KeyShare; backup: KeyShare } }>
  /** The server's final { address }: both local shares must agree. */
  keygenFinish(session: string, address: Hex): Promise<{ address: Hex }>
  signBegin(share: KeyShare, request: MpcSignRequest): Promise<{ session: string; phonePub: Hex; with: number; hash: Hex }>
  /**
   * Speed check: a full 3-party key generation, all parties here, no network.
   * Says how fast this device runs the MPC module (no keys are kept).
   */
  benchmark(): Promise<{ ms: number; cores: number }>
  /** sign-begin's reply → a box; sign-step's reply → the signature. */
  signNext(session: string, reply: { signId?: Hex; hash?: Hex; hello?: ServerHello; box: string }): Promise<{ box: string } | { signature: EcdsaSig }>
}

export function createMpcEngine(opts: {
  mpc: () => Promise<Mpc>
  identityPub: Hex | null | undefined
  /** Where the backup party's signup steps run - another core (mpcWorker.ts). */
  keygenOffload?: () => KeygenOffload | undefined
  now?: () => number
}): MpcEngine {
  const now = opts.now ?? Date.now
  const keygens = new Map<string, { k: PhoneKeygen; started: boolean; exp: number }>()
  const signs = new Map<string, { s: PhoneSign; started: boolean; exp: number }>()
  const id = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')

  function identity(): Hex {
    if (!opts.identityPub || !/^0x0[23][0-9a-fA-F]{64}$/.test(opts.identityPub)) {
      throw new MpcEngineError('The MPC wallet is not configured on this wallet frame')
    }
    return opts.identityPub
  }
  function prune() {
    const t = now()
    for (const [k, v] of keygens) if (v.exp < t) keygens.delete(k)
    for (const [k, v] of signs) if (v.exp < t) signs.delete(k)
  }
  function get<T extends { exp: number }>(map: Map<string, T>, session: string): T {
    prune()
    const e = map.get(session)
    if (!e) throw new MpcEngineError('This wallet session expired - start again')
    return e
  }
  // Any failure ends the session: a half-run MPC session is never resumed.
  async function guarded<T>(map: Map<string, unknown>, session: string, f: () => Promise<T>): Promise<T> {
    try { return await f() } catch (e) { map.delete(session); throw e }
  }

  return {
    async keygenBegin() {
      const k = new PhoneKeygen(await opts.mpc(), identity(), opts.keygenOffload?.())
      const session = id()
      prune()
      keygens.set(session, { k, started: false, exp: now() + MPC_SESSION_TTL_MS })
      return { session, phonePub: k.phonePub }
    },

    async keygenNext(session, reply) {
      const e = get(keygens, session)
      return guarded(keygens, session, async () => {
        let box: string
        if (e.started) box = await e.k.next(reply)
        else {
          if (!reply.sid || !reply.hello) throw new MpcEngineError('Expected the signing service\'s first reply')
          e.started = true
          box = await e.k.begin({ sid: reply.sid, hello: reply.hello, box: reply.box })
        }
        const shares = e.k.shares
        return shares ? { box, shares } : { box }
      })
    },

    async keygenFinish(session, address) {
      const e = get(keygens, session)
      keygens.delete(session)
      return { address: e.k.finish({ address }).address }
    },

    async benchmark() {
      const mpc = await opts.mpc()
      const sid = `0x${id()}${id()}` as Hex
      const start = performance.now()
      let states = new Map<PartyNo, KeygenState>()
      let mail: MpcMsg[] = []
      for (const p of PARTIES) { const r = keygenStart(mpc, p, sid); states.set(p, r.state); mail.push(...r.out) }
      while (states.size) {
        const next = new Map<PartyNo, KeygenState>(), out: MpcMsg[] = []
        for (const [p, st] of states) {
          const r = keygenStep(mpc, st, mail.filter(m => m.to === p))
          out.push(...r.out)
          if (!r.done) next.set(p, r.state)
        }
        states = next; mail = out
      }
      return { ms: Math.round(performance.now() - start), cores: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 0 : 0 }
    },

    async signBegin(share, request) {
      const hash = hashRequest(request)
      const s = new PhoneSign(await opts.mpc(), identity(), share, hash)
      const session = id()
      prune()
      signs.set(session, { s, started: false, exp: now() + MPC_SESSION_TTL_MS })
      return { session, phonePub: s.phonePub, with: s.with, hash }
    },

    async signNext(session, reply) {
      const e = get(signs, session)
      return guarded(signs, session, async () => {
        if (!e.started) {
          if (!reply.signId || !reply.hash || !reply.hello) throw new MpcEngineError('Expected the signing service\'s first reply')
          e.started = true
          return { box: await e.s.begin({ signId: reply.signId, hash: reply.hash, hello: reply.hello, box: reply.box }) }
        }
        signs.delete(session)
        return { signature: await e.s.next(reply) }
      })
    },
  }
}
