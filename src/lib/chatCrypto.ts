// src/lib/chatCrypto.ts
//
// ── What this is ─────────────────────────────────────────────────────────
// End-to-end encryption for chat messages, images, and files.
//
//   1. Each user has an X25519 key pair for chat, DETERMINISTICALLY derived
//      from their wallet's private key (see deriveMyChatIdentity below) —
//      not randomly generated and stored in this browser's localStorage.
//      That's the deliberate fix for a real problem the original random-
//      per-device design had: since the wallet's private key is already
//      portable across devices (via the recovery phrase / private-key
//      import this app already supports), re-importing the SAME wallet on
//      ANY device deterministically re-derives the EXACT SAME chat identity
//      — so E2E chat keeps working across a device change, reinstall, or
//      cleared browser storage, exactly like the wallet itself does. There
//      is nothing to lose track of and nothing to back up separately: the
//      chat identity is a pure function of the one secret the user already
//      has to keep safe (their wallet), never stored anywhere on its own.
//   2. The PUBLIC key is uploaded to `users.chat_public_key` (see the
//      migration adding that column) so anyone can look it up to message
//      this user — public keys are safe to share by definition.
//   3. For any two users A and B, X25519 (Diffie-Hellman over Curve25519)
//      lets each of them independently compute the SAME shared secret from
//      (their own private key + the other's public key) — without either
//      secret ever crossing the network. That shared secret, run through
//      HKDF, becomes a per-conversation AES-256-GCM key (still via the
//      browser's native Web Crypto API for the actual AES operations —
//      only the key-AGREEMENT step needs a curve Web Crypto doesn't support
//      natively; see the @noble/curves import below).
//   4. Message text and file bytes are encrypted with that key before ever
//      leaving the device, and decrypted only after arriving on the other
//      device. MeshPort's servers store and relay only ciphertext — the
//      same guarantee real E2E chat apps (Signal, WhatsApp) make, achieved
//      here with simpler, single-shared-key-per-conversation mechanics
//      rather than a full double-ratchet protocol. That's a real,
//      meaningful trade-off worth being upfront about: this protects
//      message content from MeshPort's own servers and from anyone who
//      gains read access to the database, which is the threat model that
//      actually matters for a chat-payments app — but it does not give the
//      forward-secrecy-per-message property Signal's ratchet does (a single
//      compromised private key can decrypt that conversation's full
//      history, not just future messages).
//
// ── Why X25519 via @noble/curves instead of Web Crypto's ECDH ───────────
// Web Crypto's native ECDH (P-256/P-384/P-521) has no way to generate a
// deterministic/seeded key pair — crypto.subtle.generateKey() is always
// internally random, with no seed parameter exposed. That's exactly the
// capability this needs (derive the same key pair from the same wallet
// private key, every time, on any device), so the key-AGREEMENT step uses
// @noble/curves' X25519 implementation instead — a tiny, widely-used, audited
// pure-JS library (already a transitive dependency of viem, used elsewhere
// in this app for wallet operations; pinned directly in package.json here
// too so it can't silently disappear if viem's own dependencies change).
// The actual AES-GCM encrypt/decrypt of message content still goes through
// native Web Crypto exactly as before — only the "how do two people agree
// on a shared key" step changed.
//
// ── Migration note ────────────────────────────────────────────────────────
// This replaces an earlier random-per-device P-256 keypair stored in
// localStorage. Messages encrypted under that old scheme cannot be
// retroactively decrypted (the old random private key was never derivable
// from anything else, by design — that's what made it "random"), but that
// was already a dead end under the old scheme too (a cleared localStorage
// or a new device already made those old messages permanently
// undecryptable). Every NEW message, from the moment a device upgrades to
// this scheme, encrypts under the wallet-derived identity and stays
// decryptable on any device that ever re-imports the same wallet.
//
// ── Backward compatibility ──────────────────────────────────────────────
// Every message sent before E2E chat shipped at all is plain, unencrypted
// text with no special marker. Every encrypted payload produced here is
// prefixed `"e2e:v1:"` before the base64 data — decryptText() checks for
// that prefix and returns anything without it completely unchanged. Old
// messages keep displaying exactly as they always did; nothing needs a
// backfill.
//
// ── When encryption can't happen yet ────────────────────────────────────
// If either participant hasn't opened a build with this feature yet, their
// `chat_public_key` is NULL and no shared key can be derived. Every send
// path here falls back to plaintext in that case — exactly the same
// behavior as before this feature existed — rather than blocking sending
// entirely. Once both sides have opened the app at least once, new messages
// in that conversation start encrypting automatically; no user action
// needed.

import { x25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha256'

const AES_ALGO = { name: 'AES-GCM', length: 256 }
const ENC_PREFIX = 'e2e:v1:'
// Domain separation — makes sure this derived value can only ever be used
// as a chat identity seed, never accidentally reusable for some other
// wallet-private-key-derived purpose this app (or a future one) might add.
const CHAT_IDENTITY_INFO = new TextEncoder().encode('meshport-chat-identity-v2')

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16)
  return bytes
}

/**
 * Deterministically derives this device's chat identity (X25519 key pair)
 * from the wallet's private key. Pure function — same wallet in, same key
 * pair out, on any device, every time. Never touches localStorage or any
 * other per-device state; there is nothing to generate, persist, or lose.
 * Exported (despite being an internal implementation detail of
 * getConversationKey/ensureChatKeysReady) specifically so this determinism
 * — the actual property that fixes the multi-device problem — has a direct
 * unit test rather than only being exercised indirectly through functions
 * that also need a live Supabase client and auth store to test at all.
 */
export function deriveMyChatIdentity(walletPrivateKeyHex: string): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const walletKeyBytes = hexToBytes(walletPrivateKeyHex)
  // sha256(walletKey || domain-separation info) — never expose the wallet
  // key's own bytes directly as the X25519 scalar; always go through a hash
  // with a distinct label first, standard practice for deriving one key
  // from another.
  const combined = new Uint8Array(walletKeyBytes.length + CHAT_IDENTITY_INFO.length)
  combined.set(walletKeyBytes, 0)
  combined.set(CHAT_IDENTITY_INFO, walletKeyBytes.length)
  const seed = sha256(combined)
  return { privateKey: seed, publicKey: x25519.getPublicKey(seed) }
}

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  let binary = ''
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i])
  return btoa(binary)
}
function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64)
  const arr = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i)
  return arr
}

// In-memory only, keyed by wallet address (a public identifier, safe to use
// as a Map key — unlike the private key itself, which this cache never
// stores). Re-derived on next page load; avoids re-running X25519 + HKDF on
// every single message in a conversation within one session.
const _conversationKeyCache = new Map<string, CryptoKey>()

/**
 * Ensures this wallet's chat public key is uploaded to `users.chat_public_key`.
 * Safe to call on every app mount — it's a no-op after the first successful
 * upload for a given wallet, and re-derives the exact same public key every
 * time (see deriveMyChatIdentity), so calling it again after a device change
 * just re-confirms the same value rather than generating a new identity.
 */
export async function ensureChatKeysReady(walletAddress: string, myUserId: string): Promise<void> {
  try {
    const walletPrivateKey = (await import('@/store')).useAuthStore.getState().privateKey
    if (!walletPrivateKey) return // wallet locked/not yet loaded — try again on the next mount
    const { publicKey } = deriveMyChatIdentity(walletPrivateKey)
    const publicKeyStr = toBase64(publicKey)

    const { supabase } = await import('@/lib/supabase')
    const { data: current } = await supabase.from('users').select('chat_public_key').eq('id', myUserId).maybeSingle()
    if (current?.chat_public_key === publicKeyStr) return // already up to date

    const { error } = await supabase.from('users').update({ chat_public_key: publicKeyStr }).eq('id', myUserId)
    if (error) console.error('[chatCrypto] failed to upload public key:', error.message)
  } catch (e) {
    // Never block app startup or messaging over a key-setup hiccup — the
    // send/receive paths below independently fall back to plaintext
    // whenever a usable key isn't available, so failing here just means
    // "this session sends plaintext a bit longer," not a broken app.
    console.error('[chatCrypto] ensureChatKeysReady failed:', e instanceof Error ? e.message : e)
  }
}

/**
 * Derives (and caches) the shared AES-GCM key for a conversation between
 * `myWalletAddress` and `otherUserId`. Returns null if either side doesn't
 * have a public key yet (see the file header on backward compatibility) —
 * callers treat null as "send/display as plaintext for now."
 */
export async function getConversationKey(myWalletAddress: string, otherUserId: string): Promise<CryptoKey | null> {
  const cacheKey = `${myWalletAddress.toLowerCase()}:${otherUserId}`
  const cached = _conversationKeyCache.get(cacheKey)
  if (cached) return cached

  try {
    const walletPrivateKey = (await import('@/store')).useAuthStore.getState().privateKey
    if (!walletPrivateKey) return null // wallet locked on this device right now
    const myIdentity = deriveMyChatIdentity(walletPrivateKey)

    const { supabase } = await import('@/lib/supabase')
    const { data: otherUser, error } = await supabase.from('users').select('chat_public_key').eq('id', otherUserId).maybeSingle()
    if (error || !otherUser?.chat_public_key) return null // other side hasn't opened a build with this feature yet

    const otherPublicKey = fromBase64(otherUser.chat_public_key)

    // HKDF over the raw X25519 shared secret rather than using it directly
    // as the AES key — a thin extra step, but it means the actual AES key
    // is never the raw DH output verbatim, standard practice for combining
    // a key-agreement primitive with a symmetric cipher.
    const sharedSecret = x25519.getSharedSecret(myIdentity.privateKey, otherPublicKey)
    const hkdfKey = await crypto.subtle.importKey('raw', new Uint8Array(sharedSecret), 'HKDF', false, ['deriveKey'])
    const aesKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('meshport-chat-e2e-v1') },
      hkdfKey, AES_ALGO, false, ['encrypt', 'decrypt'],
    )

    _conversationKeyCache.set(cacheKey, aesKey)
    return aesKey
  } catch (e) {
    console.error('[chatCrypto] getConversationKey failed:', e instanceof Error ? e.message : e)
    return null
  }
}


/**
 * Encrypts plaintext for storage/transmission. Returns the plaintext
 * UNCHANGED if `key` is null (no shared key available yet — see
 * getConversationKey) rather than throwing, so callers can always just
 * `content = await encryptText(content, key)` unconditionally.
 */
export async function encryptText(plaintext: string, key: CryptoKey | null): Promise<string> {
  if (!key) return plaintext
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  return ENC_PREFIX + toBase64(iv.buffer) + ':' + toBase64(ciphertext)
}

/**
 * Decrypts text produced by encryptText(). Anything without the e2e:v1:
 * prefix — every message sent before this feature existed, or a message
 * sent while no shared key was available — is returned completely
 * unchanged. Decryption FAILURES (wrong/missing key, corrupted payload)
 * also fail soft, returning a placeholder rather than throwing, so one bad
 * message can never crash the whole conversation view.
 */
export async function decryptText(payload: string, key: CryptoKey | null): Promise<string> {
  if (!payload.startsWith(ENC_PREFIX)) return payload
  if (!key) return '🔒 Encrypted message — unable to decrypt on this device'
  try {
    // ENC_PREFIX itself contains colons ("e2e:v1:"), so splitting the WHOLE
    // payload by ':' and taking [1],[2] is wrong — it grabs pieces of the
    // prefix instead of the iv/ciphertext. Strip the prefix first, then
    // split only the remainder.
    const [ivB64, ctB64] = payload.slice(ENC_PREFIX.length).split(':')
    const iv = fromBase64(ivB64)
    const ciphertext = fromBase64(ctB64)
    const plainBytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    return new TextDecoder().decode(plainBytes)
  } catch (e) {
    console.error('[chatCrypto] decryptText failed:', e instanceof Error ? e.message : e)
    return '🔒 Encrypted message — unable to decrypt'
  }
}

/**
 * Encrypts a file's bytes for upload. Returns the ORIGINAL blob unchanged
 * if `key` is null, mirroring encryptText's fallback behavior, along with
 * `encrypted: false` so callers know not to expect a decryptable payload.
 */
export async function encryptBlob(blob: Blob, key: CryptoKey | null): Promise<{ blob: Blob; ivBase64: string | null; encrypted: boolean }> {
  if (!key) return { blob, ivBase64: null, encrypted: false }
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plainBytes = await blob.arrayBuffer()
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBytes)
  return { blob: new Blob([ciphertext]), ivBase64: toBase64(iv.buffer), encrypted: true }
}

/**
 * Decrypts a downloaded file's bytes. If `ivBase64` is null (the file was
 * never encrypted — sent before this feature existed, or sent with no
 * shared key available), returns the bytes unchanged.
 */
export async function decryptBlob(encryptedBytes: ArrayBuffer, ivBase64: string | null, key: CryptoKey | null): Promise<Blob> {
  if (!ivBase64 || !key) return new Blob([encryptedBytes])
  try {
    const iv = fromBase64(ivBase64)
    const plainBytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encryptedBytes)
    return new Blob([plainBytes])
  } catch (e) {
    console.error('[chatCrypto] decryptBlob failed:', e instanceof Error ? e.message : e)
    throw e // caller shows a "couldn't decrypt this file" state — see ChatPage.tsx
  }
}

export function isEncryptedPayload(payload: string): boolean {
  return payload.startsWith(ENC_PREFIX)
}
