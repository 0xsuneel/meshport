// src/lib/chatWrap.ts
//
// The only chat operations that need the chat identity's PRIVATE key
// (audit 7 Nov M15). They run inside the wallet frame (wallet-frame/src/
// main.ts 'chat:*'), next to the wallet key the identity is derived from -
// the app never holds the chat key, in memory or in its storage. The app's
// tests use the same functions with a test identity (lib/chatCrypto.ts
// localChatOps).
//
// A message's own key (32 random bytes, made by the app) is sealed for the
// two people in the chat with AES-256-GCM under
//   HKDF-SHA256(X25519(me, peer), salt = sha256(senderPub ‖ recipientPub),
//               info = "meshport-chat-msgkey-v2")
// Old e2e:v1 messages used one key per chat: HKDF(X25519(me, peer), info =
// "meshport-chat-e2e-v1"); they're only ever opened now.

import { x25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha256'

const AES = { name: 'AES-GCM', length: 256 } as const
const MSG_KEY_INFO = new TextEncoder().encode('meshport-chat-msgkey-v2')
const V1_INFO = new TextEncoder().encode('meshport-chat-e2e-v1')

const buf = (b: Uint8Array) => new Uint8Array(b) as Uint8Array<ArrayBuffer>
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

export function chatPublicKey(seed: Uint8Array): Uint8Array {
  return x25519.getPublicKey(seed)
}

async function hkdfKey(seed: Uint8Array, peer: Uint8Array, salt: Uint8Array, info: Uint8Array): Promise<CryptoKey> {
  const shared = x25519.getSharedSecret(seed, peer)
  const base = await crypto.subtle.importKey('raw', buf(shared), 'HKDF', false, ['deriveKey'])
  shared.fill(0)
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) }, base, AES, false, ['encrypt', 'decrypt'])
}

function wrappingKey(seed: Uint8Array, peer: Uint8Array, spk: Uint8Array, rpk: Uint8Array): Promise<CryptoKey> {
  const salt = new Uint8Array(spk.length + rpk.length); salt.set(spk, 0); salt.set(rpk, spk.length)
  return hkdfKey(seed, peer, sha256(salt), MSG_KEY_INFO)
}

export class ChatWrapError extends Error {}

/**
 * Seals a message key from me (spk) to `rpk`. I must be the sender, and the
 * recipient the peer - or myself, for a message waiting for their key.
 */
export async function wrapMessageKey(seed: Uint8Array, rpk: Uint8Array, key: Uint8Array): Promise<{ spk: Uint8Array; iv: Uint8Array; wrapped: Uint8Array }> {
  if (rpk.length !== 32 || key.length !== 32) throw new ChatWrapError('bad key')
  const spk = chatPublicKey(seed)
  const wk = await wrappingKey(seed, rpk, spk, rpk)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wk, buf(key)))
  return { spk, iv, wrapped }
}

/**
 * Opens a message key sealed between spk and rpk, if I'm one of them; the
 * other side must be `expectPeer` (their wallet-signed key) or me, when
 * given. null when it isn't mine or doesn't open.
 */
export async function unwrapMessageKey(
  seed: Uint8Array, spk: Uint8Array, rpk: Uint8Array, iv: Uint8Array, wrapped: Uint8Array, expectPeer?: Uint8Array | null,
): Promise<Uint8Array | null> {
  const me = chatPublicKey(seed)
  const other = same(spk, me) ? rpk : same(rpk, me) ? spk : null
  if (!other || other.length !== 32) return null
  if (expectPeer && !same(other, expectPeer) && !same(other, me)) return null
  try {
    const wk = await wrappingKey(seed, other, spk, rpk)
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(iv) }, wk, buf(wrapped)))
  } catch { return null }
}

/** Opens an old e2e:v1 text / file (one key per chat with `peer`). */
export async function openV1(seed: Uint8Array, peer: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (peer.length !== 32) throw new ChatWrapError('bad key')
  const k = await hkdfKey(seed, peer, new Uint8Array(0), V1_INFO)
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(iv) }, k, buf(data)))
}

/** The v1 key itself - tests only (old messages are never written now). */
export function v1KeyForTests(seed: Uint8Array, peer: Uint8Array): Promise<CryptoKey> {
  return hkdfKey(seed, peer, new Uint8Array(0), V1_INFO)
}
