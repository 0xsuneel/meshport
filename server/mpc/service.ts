// server/mpc/service.ts
//
// MeshPort's side (party 2) of the 2-of-3 MPC wallet: key generation with a
// new user's phone, and co-signing with the phone or the backup share. No HTTP
// and no database here - api/wallet-mpc.ts supplies those.
//
// Stateless between requests: a round's secret working state goes back to the
// client sealed (AES-256-GCM, bound to the user and the session, 5 minutes).
// The server's share is stored sealed with a different key, bound to the
// user and the address. Both keys come from one server-only secret.
//
// The server only co-signs a hash it computed itself (requests.ts, from the
// transaction or message the client sent), and that hash is sealed into the
// session, so the client can't swap it between rounds.

import type { Mpc } from '../../src/wallet/mpc/wasm'
import {
  BACKUP, PHONE, SERVER, keygenReady, keygenStart, keygenStep, signReady, signStart, signStep,
  type Hex, type KeyShare, type KeygenState, type MpcMsg, type PartyNo, type SignState,
} from '../../src/wallet/mpc/protocol'
import { identityFromSeed, newEphemeral, openChannel, packJson, signHello, unpackJson, type SessionKind } from '../../src/wallet/mpc/channel'

export const STATE_TTL_MS = 5 * 60_000

export class MpcServiceError extends Error {
  constructor(public code: 'exists' | 'no-wallet' | 'expired' | 'replayed' | 'bad-request' | 'protocol', message: string) {
    super(message)
  }
}

export interface MpcRepo {
  /** The user's active server share (sealed), if any. */
  activeShare(authUid: string): Promise<{ address: string; shareCt: string } | null>
  /** Store the server share for a new wallet; 'exists' if the user already has one. */
  saveShare(authUid: string, address: string, shareCt: string): Promise<'saved' | 'exists'>
  /**
   * Mark one step of one session used; false if it already was. The server
   * keeps no state between requests, so this is what stops a client sending
   * the same sealed state twice - re-running an MPC round from the same state
   * ("rewinding") can leak the server's share.
   */
  consumeStep(sessionId: Hex, step: number): Promise<boolean>
  /** Audit trail: every hash the server agreed to co-sign. */
  logSign(entry: { authUid: string; address: string; signId: Hex; hash: Hex; kind: string; summary: unknown }): Promise<void>
}

/**
 * Every protocol message to or from the phone travels in an end-to-end box
 * (src/wallet/mpc/channel.ts): the app page that carries them learns nothing.
 * `hello` = the server's session key, signed by its identity key, which the
 * wallet frame has built in. Boxes are numbered: begin's reply is box 0, then
 * each request and its reply share the next number.
 */
export interface Hello { serverPub: Hex; sig: Hex }

export interface MpcService {
  /** The identity public key to build into the wallet frame (VITE_WALLET_MPC_SERVER_KEY). */
  identityPub: Hex
  keygenBegin(authUid: string, phonePub: Hex): Promise<{ sid: Hex; hello: Hello; box: string; token: string }>
  keygenStep(authUid: string, token: string, box: string): Promise<{ box: string; token: string } | { address: Hex }>
  signBegin(authUid: string, req: { hash: Hex; with: PartyNo; kind: string; summary: unknown }, phonePub: Hex): Promise<{ signId: Hex; hash: Hex; address: Hex; hello: Hello; box: string; token: string }>
  signStep(authUid: string, token: string, box: string): Promise<{ box: string; token: string }>
}

/** What the server keeps (sealed) between requests of one session. */
interface Session<P> { proto: P; eph: Hex; phonePub: Hex; step: number; sessionId: Hex }

// ── Sealing ─────────────────────────────────────────────────────────────────

const enc = new TextEncoder()
const dec = new TextDecoder()
const fromB64 = (s: string) => {
  const n = s.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(n + '='.repeat((4 - (n.length % 4)) % 4)), c => c.charCodeAt(0))
}
// Large payloads (a key share is ~300 KB): String.fromCharCode(...b) would overflow the stack.
function bytesToB64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function deriveKey(secret: Uint8Array, label: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new Uint8Array(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('meshport-mpc-v1'), info: enc.encode(label) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}

async function seal(key: CryptoKey, aad: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, new Uint8Array(await packJson(value))))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv); out.set(ct, 12)
  return bytesToB64(out)
}

async function open<T>(key: CryptoKey, aad: string, token: string): Promise<T> {
  try {
    const raw = fromB64(token)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: enc.encode(aad) }, key, raw.subarray(12))
    return await unpackJson<T>(new Uint8Array(pt))
  } catch {
    throw new MpcServiceError('bad-request', 'This request is not valid for your session')
  }
}

const randomHex = (n = 32): Hex => `0x${Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('')}`

// ── Service ─────────────────────────────────────────────────────────────────

interface Sealed<S> { kind: 'keygen' | 'sign'; exp: number; state: S }

export async function createMpcService(opts: { mpc: Mpc; repo: MpcRepo; secret: Uint8Array; now?: () => number }): Promise<MpcService> {
  if (opts.secret.length < 32) throw new Error('MPC secret must be at least 32 bytes')
  const { mpc, repo } = opts
  const now = opts.now ?? Date.now
  const [stateKey, shareKey] = await Promise.all([deriveKey(opts.secret, 'round-state'), deriveKey(opts.secret, 'server-share')])

  const sealState = <S>(authUid: string, kind: Sealed<S>['kind'], state: S) =>
    seal(stateKey, `state|${authUid}|${kind}`, { kind, exp: now() + STATE_TTL_MS, state })
  async function openState<S>(authUid: string, kind: Sealed<S>['kind'], token: string): Promise<S> {
    const s = await open<Sealed<S>>(stateKey, `state|${authUid}|${kind}`, token)
    if (s.kind !== kind) throw new MpcServiceError('bad-request', 'Wrong kind of session')
    if (s.exp < now()) throw new MpcServiceError('expired', 'This session expired - start again')
    return s.state
  }

  async function loadShare(authUid: string): Promise<{ address: Hex; share: KeyShare }> {
    const row = await repo.activeShare(authUid)
    if (!row) throw new MpcServiceError('no-wallet', 'No MPC wallet for this account')
    const share = await open<KeyShare>(shareKey, `share|${authUid}|${row.address.toLowerCase()}`, row.shareCt)
    return { address: row.address.toLowerCase() as Hex, share }
  }

  // Messages the server accepts: only to itself, only from the phone or the backup.
  function inboxFor(inbox: unknown): MpcMsg[] {
    if (!Array.isArray(inbox)) throw new MpcServiceError('bad-request', 'Messages must be a list')
    return inbox.filter((m): m is MpcMsg => !!m && typeof m === 'object' && (m as MpcMsg).to === SERVER)
      .map(m => {
        if (m.from !== PHONE && m.from !== BACKUP) throw new MpcServiceError('bad-request', `Unexpected sender ${String(m.from)}`)
        return m
      })
  }

  const protocol = <T>(f: () => T): T => {
    try { return f() } catch (e) {
      if (e instanceof MpcServiceError) throw e
      throw new MpcServiceError('protocol', e instanceof Error ? e.message : 'MPC step failed')
    }
  }

  const identity = await identityFromSeed(opts.secret)

  /** A fresh session key, vouched for by the identity key. */
  async function hello(kind: SessionKind, sessionId: Hex, phonePub: Hex) {
    if (!/^0x0[23][0-9a-fA-F]{64}$/.test(phonePub)) throw new MpcServiceError('bad-request', 'Missing session key')
    const eph = newEphemeral()
    const channel = await openChannel('server', eph.priv, phonePub, kind, sessionId)
      .catch(() => { throw new MpcServiceError('bad-request', 'Bad session key') })
    const sig = await signHello(identity.priv, kind, sessionId, phonePub, eph.pub)
    return { channel, eph: eph.priv, hello: { serverPub: eph.pub, sig } }
  }

  async function resume<P>(authUid: string, kind: SessionKind, token: string, box: string) {
    const s = await openState<Session<P>>(authUid, kind, token)
    const channel = await openChannel('server', s.eph, s.phonePub, kind, s.sessionId)
    const msgs = await channel.open(String(box ?? ''), s.step).catch(() => {
      throw new MpcServiceError('bad-request', 'A message was altered, replayed or sent out of order')
    })
    if (!(await repo.consumeStep(s.sessionId, s.step))) throw new MpcServiceError('replayed', 'This step was already used - start again')
    return { s, channel, msgs: inboxFor(msgs) }
  }

  return {
    identityPub: identity.pub,

    async keygenBegin(authUid, phonePub) {
      if (await repo.activeShare(authUid)) throw new MpcServiceError('exists', 'This account already has an MPC wallet')
      const sid = randomHex()
      const h = await hello('keygen', sid, phonePub)
      const r = protocol(() => keygenStart(mpc, SERVER, sid))
      const session = { proto: r.state, eph: h.eph, phonePub, step: 1, sessionId: sid }
      return { sid, hello: h.hello, box: await h.channel.seal(r.out, 0), token: await sealState(authUid, 'keygen', session) }
    },

    async keygenStep(authUid, token, box) {
      const { s, channel, msgs } = await resume<KeygenState>(authUid, 'keygen', token, box)
      // Every round the phone already sent messages for (rounds 1+2, then 3).
      let state = s.proto
      const out: MpcMsg[] = []
      if (!keygenReady(state, msgs)) throw new MpcServiceError('bad-request', 'No messages for this round')
      while (keygenReady(state, msgs)) {
        const st = state
        const r = protocol(() => keygenStep(mpc, st, msgs))
        if (r.done) {
          const address = r.done.address.toLowerCase() as Hex
          const shareCt = await seal(shareKey, `share|${authUid}|${address}`, r.done.share)
          if (await repo.saveShare(authUid, address, shareCt) === 'exists') {
            throw new MpcServiceError('exists', 'This account already has an MPC wallet')
          }
          return { address }
        }
        out.push(...r.out)
        state = r.state
      }
      const next = { ...s, proto: state, step: s.step + 1 }
      return { box: await channel.seal(out, s.step), token: await sealState(authUid, 'keygen', next) }
    },

    async signBegin(authUid, req, phonePub) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(req.hash)) throw new MpcServiceError('bad-request', 'Not a 32-byte hash')
      // The phone every day; the backup share on a new phone (until it's re-shared).
      if (req.with !== PHONE && req.with !== BACKUP) throw new MpcServiceError('bad-request', 'Sign with the phone or the backup share')
      const { address, share } = await loadShare(authUid)
      const signId = randomHex()
      const h = await hello('sign', signId, phonePub)
      await repo.logSign({ authUid, address, signId, hash: req.hash, kind: req.kind, summary: req.summary })
      const r = protocol(() => signStart(mpc, share, req.with, signId, req.hash))
      const session = { proto: r.state, eph: h.eph, phonePub, step: 1, sessionId: signId }
      return { signId, hash: req.hash, address, hello: h.hello, box: await h.channel.seal(r.out, 0), token: await sealState(authUid, 'sign', session) }
    },

    // Signing rounds are cheap (~10 ms), so one request runs every round the
    // client already has messages for: rounds 1 and 2 together.
    async signStep(authUid, token, box) {
      const { s, channel, msgs } = await resume<SignState>(authUid, 'sign', token, box)
      const { share } = await loadShare(authUid)
      let state = s.proto
      const out: MpcMsg[] = []
      // The server never needs its own final round: the phone finishes the signature.
      while (state.round < 3 && signReady(state, msgs)) {
        const st = state
        const r = protocol(() => signStep(mpc, share, st, msgs))
        out.push(...r.out)
        if (r.done) break
        state = r.state
      }
      if (!out.length) throw new MpcServiceError('bad-request', 'No messages for this round')
      const next = { ...s, proto: state, step: s.step + 1 }
      return { box: await channel.seal(out, s.step), token: await sealState(authUid, 'sign', next) }
    },
  }
}
