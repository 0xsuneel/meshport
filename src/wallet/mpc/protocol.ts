// src/wallet/mpc/protocol.ts
//
// One party's side of MeshPort's 2-of-3 MPC wallet, as plain steps:
//
//   key generation   start → step → step → step → { share, address }   (3 message rounds)
//   signing          start → step → step → step → { r, s, v }          (3 message rounds)
//
// Each step takes the messages addressed to this party and returns the next
// state plus messages for the others. State is plain JSON, so the server can
// seal it between HTTP requests and the phone can keep it in memory. Nothing
// here talks to the network: the caller carries messages between parties.
//
// Parties: 1 = phone (wallet frame), 2 = MeshPort server, 3 = backup. At
// signup the phone plays parties 1 and 3 and exports 3's share as the backup.

import type { Mpc } from './wasm'
import type { Hex } from '../protocol'

export const PHONE = 1, SERVER = 2, BACKUP = 3
export const PARTIES = [PHONE, SERVER, BACKUP] as const
export type PartyNo = typeof PARTIES[number]

/** A message from one party to another. `body` is opaque protocol data. */
export interface MpcMsg { from: PartyNo; to: PartyNo; kind: string; body: unknown }

/** A party's key share (secret). Holds the party index and the public key. */
export type KeyShare = Record<string, unknown> & { party_index: number }

export class MpcProtocolError extends Error {}

const others = (i: PartyNo) => PARTIES.filter(p => p !== i)
const receiverOf = (m: unknown): PartyNo => (m as { parties: { receiver: PartyNo } }).parties.receiver

function take(inbox: MpcMsg[], me: PartyNo, kind: string, from: readonly PartyNo[]): Map<PartyNo, unknown[]> {
  const got = new Map<PartyNo, unknown[]>()
  for (const m of inbox) {
    if (m.to !== me || m.kind !== kind) continue
    if (!from.includes(m.from)) throw new MpcProtocolError(`unexpected ${kind} from party ${m.from}`)
    got.set(m.from, [...(got.get(m.from) ?? []), m.body])
  }
  for (const p of from) if (!got.has(p)) throw new MpcProtocolError(`missing ${kind} from party ${p}`)
  return got
}

const one = (got: Map<PartyNo, unknown[]>, p: PartyNo) => {
  const v = got.get(p)!
  if (v.length !== 1) throw new MpcProtocolError(`expected one message from party ${p}`)
  return v[0]
}

// ── Key generation ──────────────────────────────────────────────────────────

export interface KeygenState {
  i: PartyNo
  sid: Hex
  round: 1 | 2 | 3
  own: Record<string, unknown>
}

export type KeygenStep =
  | { state: KeygenState; out: MpcMsg[]; done?: undefined }
  | { done: { share: KeyShare; address: Hex }; state?: undefined; out: MpcMsg[] }

/** Round 0: this party's polynomial fragments, one privately to each other party. */
export function keygenStart(mpc: Mpc, i: PartyNo, sid: Hex): { state: KeygenState; out: MpcMsg[] } {
  const { fragments } = mpc.call<{ fragments: unknown[] }>('dkg1', { i, sid })
  const out = others(i).map(to => ({ from: i, to, kind: 'frag', body: fragments[to - 1] }))
  return { state: { i, sid, round: 1, own: { frag: fragments[i - 1] } }, out }
}

export function keygenStep(mpc: Mpc, state: KeygenState, inbox: MpcMsg[]): KeygenStep {
  const { i, sid } = state
  const peers = others(i)

  if (state.round === 1) {
    const frags = take(inbox, i, 'frag', peers)
    const fragments = PARTIES.map(p => (p === i ? state.own.frag : one(frags, p)))
    const r = mpc.call<{ state: unknown; proof: unknown; zero_transmit: unknown[]; bip: unknown }>('dkg2', { i, sid, fragments })
    const out: MpcMsg[] = [
      ...peers.map(to => ({ from: i, to, kind: 'proof', body: r.proof })),
      ...peers.map(to => ({ from: i, to, kind: 'bip2', body: r.bip })),
      ...r.zero_transmit.map(body => ({ from: i, to: receiverOf(body), kind: 'zero2', body })),
    ]
    return { state: { ...state, round: 2, own: { s: r.state, proof: r.proof, bip2: r.bip } }, out }
  }

  if (state.round === 2) {
    const proofs = take(inbox, i, 'proof', peers)
    const bip2 = take(inbox, i, 'bip2', peers)
    const zero2 = take(inbox, i, 'zero2', peers)
    const r = mpc.call<{ state: unknown; zero_transmit: unknown[]; mul_transmit: unknown[]; bip: unknown }>('dkg3', { i, sid, state: state.own.s })
    const out: MpcMsg[] = [
      ...peers.map(to => ({ from: i, to, kind: 'bip3', body: r.bip })),
      ...r.zero_transmit.map(body => ({ from: i, to: receiverOf(body), kind: 'zero3', body })),
      ...r.mul_transmit.map(body => ({ from: i, to: receiverOf(body), kind: 'mul', body })),
    ]
    const own = {
      s: r.state, bip3: r.bip,
      proofs: PARTIES.map(p => (p === i ? state.own.proof : one(proofs, p))),
      bip2: PARTIES.map(p => [p, p === i ? state.own.bip2 : one(bip2, p)]),
      zero2: peers.flatMap(p => zero2.get(p)!),
    }
    return { state: { ...state, round: 3, own }, out }
  }

  const zero3 = take(inbox, i, 'zero3', peers)
  const mul = take(inbox, i, 'mul', peers)
  const bip3 = take(inbox, i, 'bip3', peers)
  const r = mpc.call<{ share: KeyShare; address: Hex }>('dkg4', {
    i, sid, state: state.own.s,
    proofs: state.own.proofs, zero2: state.own.zero2,
    zero3: peers.flatMap(p => zero3.get(p)!), mul: peers.flatMap(p => mul.get(p)!),
    bip2: state.own.bip2, bip3: PARTIES.map(p => [p, p === i ? state.own.bip3 : one(bip3, p)]),
  })
  return { done: r, out: [] }
}

// ── Signing ─────────────────────────────────────────────────────────────────

export interface SignState {
  i: PartyNo
  with: PartyNo
  signId: Hex
  hash: Hex
  round: 1 | 2 | 3
  own: Record<string, unknown>
}

export interface EcdsaSig { r: Hex; s: Hex; v: 27 | 28 }

export type SignStep =
  | { state: SignState; out: MpcMsg[]; done?: undefined }
  | { done: EcdsaSig; state?: undefined; out: MpcMsg[] }

const signArgs = (share: KeyShare, st: Pick<SignState, 'with' | 'signId' | 'hash'>) =>
  ({ share, sign_id: st.signId, with: st.with, hash: st.hash })

/** Start signing `hash` together with party `withParty`. `signId`: fresh, shared by both. */
export function signStart(mpc: Mpc, share: KeyShare, withParty: PartyNo, signId: Hex, hash: Hex): { state: SignState; out: MpcMsg[] } {
  const i = share.party_index as PartyNo
  const st = { with: withParty, signId, hash }
  const r = mpc.call<{ state: unknown; transmit: unknown[] }>('sign1', { base: signArgs(share, st) })
  return {
    state: { i, ...st, round: 1, own: { s: r.state } },
    out: r.transmit.map(body => ({ from: i, to: receiverOf(body), kind: 's1', body })),
  }
}

export function signStep(mpc: Mpc, share: KeyShare, state: SignState, inbox: MpcMsg[]): SignStep {
  const { i } = state
  const peer = [state.with] as const
  const args = signArgs(share, state)

  if (state.round === 1) {
    const received = take(inbox, i, 's1', peer).get(state.with)!
    const r = mpc.call<{ state: unknown; transmit: unknown[] }>('sign2', { base: args, state: state.own.s, received })
    return {
      state: { ...state, round: 2, own: { s: r.state } },
      out: r.transmit.map(body => ({ from: i, to: receiverOf(body), kind: 's2', body })),
    }
  }

  if (state.round === 2) {
    const received = take(inbox, i, 's2', peer).get(state.with)!
    const r = mpc.call<{ state: unknown; broadcast: unknown }>('sign3', { base: args, state: state.own.s, received })
    return {
      state: { ...state, round: 3, own: { s: r.state, broadcast: r.broadcast } },
      out: [{ from: i, to: state.with, kind: 's3', body: r.broadcast }],
    }
  }

  const theirs = one(take(inbox, i, 's3', peer), state.with)
  const broadcasts = i < state.with ? [state.own.broadcast, theirs] : [theirs, state.own.broadcast]
  const sig = mpc.call<EcdsaSig>('sign4', { base: args, state: state.own.s, broadcasts })
  return { done: sig, out: [] }
}

/** The wallet address a share belongs to (no secret leaves the module). */
export function shareAddress(mpc: Mpc, share: KeyShare): Hex {
  return mpc.call<{ address: Hex }>('share_info', { share }).address
}
