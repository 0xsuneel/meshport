// supabase/functions/wallet-mpc/logic.ts
//
// MeshPort's side (party 2) of the 2-of-3 MPC wallet: key generation with a
// new user's phone, and co-signing with the phone. No HTTP and no database
// here - index.ts supplies those - so this runs under Deno and vitest alike.
//
// Stateless between requests: a round's secret working state goes back to the
// client sealed (AES-256-GCM, bound to the user and the session, 5 minutes).
// The server's share is stored sealed with a different key, bound to the
// user and the address. Both keys come from one server-only secret.
//
// The server only co-signs a hash it computed itself (index.ts, from the
// transaction or message the client sent), and that hash is sealed into the
// session, so the client can't swap it between rounds.

import type { Mpc } from '../_shared/mpc/wasm.ts'
import {
  BACKUP, PHONE, SERVER, keygenStart, keygenStep, signStart, signStep,
  type Hex, type KeyShare, type KeygenState, type MpcMsg, type PartyNo, type SignState,
} from '../_shared/mpc/protocol.ts'

export const STATE_TTL_MS = 5 * 60_000

export class MpcServiceError extends Error {
  constructor(public code: 'exists' | 'no-wallet' | 'expired' | 'bad-request' | 'protocol', message: string) {
    super(message)
  }
}

export interface MpcRepo {
  /** The user's active server share (sealed), if any. */
  activeShare(authUid: string): Promise<{ address: string; shareCt: string } | null>
  /** Store the server share for a new wallet; 'exists' if the user already has one. */
  saveShare(authUid: string, address: string, shareCt: string): Promise<'saved' | 'exists'>
  /** Audit trail: every hash the server agreed to co-sign. */
  logSign(entry: { authUid: string; address: string; signId: Hex; hash: Hex; kind: string; summary: unknown }): Promise<void>
}

export interface MpcService {
  keygenBegin(authUid: string): Promise<{ sid: Hex; out: MpcMsg[]; token: string }>
  keygenStep(authUid: string, token: string, inbox: MpcMsg[]): Promise<{ out: MpcMsg[]; token: string } | { address: Hex }>
  signBegin(authUid: string, req: { hash: Hex; with: PartyNo; kind: string; summary: unknown }): Promise<{ signId: Hex; hash: Hex; address: Hex; out: MpcMsg[]; token: string }>
  signStep(authUid: string, token: string, inbox: MpcMsg[]): Promise<{ out: MpcMsg[]; token: string }>
}

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
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(value))))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv); out.set(ct, 12)
  return bytesToB64(out)
}

async function open<T>(key: CryptoKey, aad: string, token: string): Promise<T> {
  try {
    const raw = fromB64(token)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: enc.encode(aad) }, key, raw.subarray(12))
    return JSON.parse(dec.decode(pt)) as T
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

  return {
    async keygenBegin(authUid) {
      if (await repo.activeShare(authUid)) throw new MpcServiceError('exists', 'This account already has an MPC wallet')
      const sid = randomHex()
      const r = protocol(() => keygenStart(mpc, SERVER, sid))
      return { sid, out: r.out, token: await sealState(authUid, 'keygen', r.state) }
    },

    async keygenStep(authUid, token, inbox) {
      const state = await openState<KeygenState>(authUid, 'keygen', token)
      const r = protocol(() => keygenStep(mpc, state, inboxFor(inbox)))
      if (!r.done) return { out: r.out, token: await sealState(authUid, 'keygen', r.state) }
      const address = r.done.address.toLowerCase() as Hex
      const shareCt = await seal(shareKey, `share|${authUid}|${address}`, r.done.share)
      if (await repo.saveShare(authUid, address, shareCt) === 'exists') {
        throw new MpcServiceError('exists', 'This account already has an MPC wallet')
      }
      return { address }
    },

    async signBegin(authUid, req) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(req.hash)) throw new MpcServiceError('bad-request', 'Not a 32-byte hash')
      // The phone every day; the backup share on a new phone (until it's re-shared).
      if (req.with !== PHONE && req.with !== BACKUP) throw new MpcServiceError('bad-request', 'Sign with the phone or the backup share')
      const { address, share } = await loadShare(authUid)
      const signId = randomHex()
      await repo.logSign({ authUid, address, signId, hash: req.hash, kind: req.kind, summary: req.summary })
      const r = protocol(() => signStart(mpc, share, req.with, signId, req.hash))
      return { signId, hash: req.hash, address, out: r.out, token: await sealState(authUid, 'sign', r.state) }
    },

    // Signing rounds are cheap (~10 ms), so one request runs every round the
    // client already has messages for: rounds 1 and 2 together.
    async signStep(authUid, token, inbox) {
      let state = await openState<SignState>(authUid, 'sign', token)
      const { share } = await loadShare(authUid)
      const msgs = inboxFor(inbox)
      const out: MpcMsg[] = []
      while (state.round < 3 && msgs.some(m => m.kind === `s${state.round}`)) {
        const st = state
        const r = protocol(() => signStep(mpc, share, st, msgs.filter(m => m.kind === `s${st.round}`)))
        out.push(...r.out)
        if (r.done) break
        state = r.state
      }
      if (!out.length) throw new MpcServiceError('bad-request', 'No messages for this round')
      return { out, token: await sealState(authUid, 'sign', state) }
    },
  }
}
