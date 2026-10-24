// src/wallet/mpc/channel.ts
//
// End-to-end encryption between the wallet frame (phone/backup parties) and
// the MPC signing service (party 2). The app page carries the messages - the
// frame has no network access - and must learn nothing from them: DKLs
// messages include secret polynomial fragments and zero-share seeds.
//
//   hello   frame: fresh P-256 key  ──────────▶  server: fresh P-256 key, and an
//           ◀──────────  identity signature over both keys and the session id
//   frame   checks that signature against the identity key built into the
//           frame (VITE_WALLET_MPC_SERVER_KEY), so the app page can't stand in
//           for the server
//   both    ECDH → HKDF(session id) → one AES-256-GCM key per direction
//   boxes   each carries a counter in its authenticated data: no replay,
//           no reordering, no moving a box between sessions
//
// Shared by the frame (browser) and server/mpc (Node): only Web Crypto and
// @noble/curves.

import { p256 } from '@noble/curves/p256'
import type { Hex, MpcMsg } from './protocol'

export type Role = 'phone' | 'server'
export type SessionKind = 'keygen' | 'sign'

export class ChannelError extends Error {}

const enc = new TextEncoder()
const dec = new TextDecoder()

export const toHex = (b: Uint8Array): Hex => `0x${Array.from(b, x => x.toString(16).padStart(2, '0')).join('')}`
export function fromHex(h: string): Uint8Array<ArrayBuffer> {
  const s = h.startsWith('0x') ? h.slice(2) : h
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(s)) throw new ChannelError('bad hex')
  return Uint8Array.from(s.match(/../g) ?? [], b => parseInt(b, 16))
}
function b64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))

// ── Compression ─────────────────────────────────────────────────────────────
// MPC messages and states are JSON in which every byte is a decimal number -
// ~3.6x their size - and once encrypted nothing on the way can compress them.
// So they're deflated before encryption. The first plaintext byte says which:
// PACKED (deflate-raw) or '[' / '{' (plain JSON, from older builds), so frame
// and server versions can differ during a deploy.
const PACKED = 0x01

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(stream))
  return new Uint8Array(await out.arrayBuffer())
}

/** JSON → bytes to encrypt (deflated, marked). */
export async function packJson(value: unknown): Promise<Uint8Array> {
  const raw = enc.encode(JSON.stringify(value))
  if (typeof CompressionStream === 'undefined') return raw
  const z = await pipe(raw, new CompressionStream('deflate-raw'))
  const out = new Uint8Array(z.length + 1)
  out[0] = PACKED; out.set(z, 1)
  return out
}

/** Decrypted bytes → JSON, packed or plain. */
export async function unpackJson<T>(bytes: Uint8Array): Promise<T> {
  const text = bytes[0] === PACKED
    ? dec.decode(await pipe(bytes.subarray(1), new DecompressionStream('deflate-raw')))
    : dec.decode(bytes)
  return JSON.parse(text) as T
}

/** A fresh ECDH key for one session. `pub` is compressed (33 bytes). */
export function newEphemeral(): { priv: Hex; pub: Hex } {
  const priv = p256.utils.randomPrivateKey()
  return { priv: toHex(priv), pub: toHex(p256.getPublicKey(priv, true)) }
}

/** What the server's identity key signs: both session keys and the session. */
function helloDigest(kind: SessionKind, sessionId: Hex, phonePub: Hex, serverPub: Hex): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', enc.encode(`meshport-mpc-hello|v1|${kind}|${sessionId}|${phonePub}|${serverPub}`.toLowerCase()))
}

export async function signHello(identityPriv: Uint8Array, kind: SessionKind, sessionId: Hex, phonePub: Hex, serverPub: Hex): Promise<Hex> {
  const digest = new Uint8Array(await helloDigest(kind, sessionId, phonePub, serverPub))
  return toHex(p256.sign(digest, identityPriv, { lowS: true }).toCompactRawBytes())
}

export async function verifyHello(identityPub: Hex, kind: SessionKind, sessionId: Hex, phonePub: Hex, serverPub: Hex, sig: Hex): Promise<void> {
  const digest = new Uint8Array(await helloDigest(kind, sessionId, phonePub, serverPub))
  let ok = false
  try { ok = p256.verify(fromHex(sig), digest, fromHex(identityPub)) } catch { ok = false }
  if (!ok) throw new ChannelError('The signing service could not prove who it is')
}

/** Identity key from server-side key material (deterministic, valid P-256 scalar). */
export async function identityFromSeed(seed: Uint8Array): Promise<{ priv: Uint8Array; pub: Hex }> {
  for (let counter = 0; counter < 16; counter++) {
    const base = await crypto.subtle.importKey('raw', new Uint8Array(seed), 'HKDF', false, ['deriveBits'])
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('meshport-mpc-v1'), info: enc.encode(`server-identity|${counter}`) }, base, 256))
    if (p256.utils.isValidPrivateKey(bits)) return { priv: bits, pub: toHex(p256.getPublicKey(bits, true)) }
  }
  throw new ChannelError('could not derive an identity key')
}

export interface Channel {
  /** Encrypt this side's messages for the given step (counter). */
  seal(msgs: MpcMsg[], step: number): Promise<string>
  /** Decrypt the other side's box for the given step; throws if anything is off. */
  open(box: string, step: number): Promise<MpcMsg[]>
}

/** Both sides call this with their own role; keys come out mirrored. */
export async function openChannel(role: Role, myPriv: Hex, theirPub: Hex, kind: SessionKind, sessionId: Hex): Promise<Channel> {
  let shared: Uint8Array
  try { shared = p256.getSharedSecret(fromHex(myPriv), fromHex(theirPub), true).subarray(1) } catch {
    throw new ChannelError('bad session key')
  }
  const base = await crypto.subtle.importKey('raw', new Uint8Array(shared), 'HKDF', false, ['deriveKey'])
  const key = (dir: string) => crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: fromHex(sessionId), info: enc.encode(`meshport-mpc-e2e|v1|${kind}|${dir}`) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const [toServer, toPhone] = await Promise.all([key('phone->server'), key('server->phone')])
  const [sendKey, recvKey, sendDir, recvDir] = role === 'phone'
    ? [toServer, toPhone, 'phone->server', 'server->phone']
    : [toPhone, toServer, 'server->phone', 'phone->server']
  const aad = (dir: string, step: number) => enc.encode(`${kind}|${sessionId}|${dir}|${step}`.toLowerCase())

  return {
    async seal(msgs, step) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const plain = await packJson(msgs)
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(sendDir, step) }, sendKey, new Uint8Array(plain)))
      const out = new Uint8Array(12 + ct.length)
      out.set(iv); out.set(ct, 12)
      return b64(out)
    },
    async open(box, step) {
      try {
        const raw = unb64(box)
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: aad(recvDir, step) }, recvKey, raw.subarray(12))
        const msgs = await unpackJson<unknown>(new Uint8Array(pt))
        if (!Array.isArray(msgs)) throw new Error('not a list')
        return msgs as MpcMsg[]
      } catch {
        throw new ChannelError('A message was altered, replayed or sent out of order')
      }
    },
  }
}
