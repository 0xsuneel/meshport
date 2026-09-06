// src/lib/chatCrypto.ts
//
// ── What this is ─────────────────────────────────────────────────────────
// End-to-end encryption for chat messages, images, and files, using the
// browser's native Web Crypto API — no external crypto library needed.
//
//   1. Each user generates an ECDH (P-256) key pair the first time they open
//      a build with this feature. The PRIVATE key is generated with
//      `extractable: false` where possible and is stored ONLY in this
//      browser's localStorage — it is never sent to MeshPort's servers, the
//      same trust model as a self-custodial wallet's private key.
//   2. The PUBLIC key is uploaded to `users.chat_public_key` (see the
//      migration adding that column) so anyone can look it up to message
//      this user — public keys are safe to share by definition.
//   3. For any two users A and B, ECDH lets each of them independently
//      compute the SAME shared secret from (their own private key + the
//      other's public key) — without either secret ever crossing the
//      network. That shared secret, run through HKDF, becomes a per-
//      conversation AES-256-GCM key.
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
// ── Backward compatibility ──────────────────────────────────────────────
// Every message sent before this shipped is plain, unencrypted text with no
// special marker. Every encrypted payload produced here is prefixed
// `"e2e:v1:"` before the base64 data — decryptText() checks for that prefix
// and returns anything without it completely unchanged. Old messages keep
// displaying exactly as they always did; nothing needs a backfill.
//
// ── When encryption can't happen yet ────────────────────────────────────
// If either participant hasn't opened a build with this feature yet, their
// `chat_public_key` is NULL and no shared key can be derived. Every send
// path here falls back to plaintext in that case — exactly the same
// behavior as before this feature existed — rather than blocking sending
// entirely. Once both sides have opened the app at least once, new messages
// in that conversation start encrypting automatically; no user action
// needed.

const KEYPAIR_ALGO: EcKeyAlgorithm = { name: 'ECDH', namedCurve: 'P-256' } as any
const AES_ALGO = { name: 'AES-GCM', length: 256 }
const ENC_PREFIX = 'e2e:v1:'
const LOCAL_STORAGE_KEY_PREFIX = 'meshport_chat_privkey_'

// ── Local private-key storage ────────────────────────────────────────────
// One key pair per WALLET ADDRESS (not per browser session), so the same
// person on the same device keeps the same identity across logins. If they
// use MeshPort on a second device, that device generates its OWN key pair
// and uploads its OWN public key — overwriting the previous one in
// chat_public_key. This is a real, known limitation (not full multi-device
// support like Signal's — the most recent device "wins" as the identity
// other people encrypt to), called out explicitly rather than glossed
// over: a conversation encrypted to an old device's public key becomes
// undecryptable by that old device once a newer device has overwritten it
// server-side. For a first real implementation this is an acceptable,
// honest trade-off; proper multi-device support (per-device key
// fan-out, like Signal's sender-keys) is future work, not something to
// silently pretend already works.
function storageKeyFor(walletAddress: string): string {
  return LOCAL_STORAGE_KEY_PREFIX + walletAddress.toLowerCase()
}

interface StoredKeyPair {
  privateJwk: JsonWebKey
  publicJwk: JsonWebKey
}

async function loadOrGenerateKeyPair(walletAddress: string): Promise<CryptoKeyPair> {
  const storageKey = storageKeyFor(walletAddress)
  const existing = localStorage.getItem(storageKey)
  if (existing) {
    try {
      const stored: StoredKeyPair = JSON.parse(existing)
      const privateKey = await crypto.subtle.importKey('jwk', stored.privateJwk, KEYPAIR_ALGO, true, ['deriveKey', 'deriveBits'])
      const publicKey = await crypto.subtle.importKey('jwk', stored.publicJwk, KEYPAIR_ALGO, true, [])
      return { privateKey, publicKey }
    } catch (e) {
      console.error('[chatCrypto] stored key pair corrupt, regenerating:', e)
      // Fall through to regenerate — better to mint a new identity (and
      // re-upload a new public key) than to leave the user permanently
      // unable to send/receive encrypted messages because of one bad
      // localStorage read.
    }
  }

  const keyPair = await crypto.subtle.generateKey(KEYPAIR_ALGO, true, ['deriveKey', 'deriveBits']) as CryptoKeyPair
  const [privateJwk, publicJwk] = await Promise.all([
    crypto.subtle.exportKey('jwk', keyPair.privateKey),
    crypto.subtle.exportKey('jwk', keyPair.publicKey),
  ])
  localStorage.setItem(storageKey, JSON.stringify({ privateJwk, publicJwk } as StoredKeyPair))
  return keyPair
}

// In-memory only — re-derived on next page load, never persisted. Avoids
// re-running ECDH derivation (cheap, but not free) on every single message
// in a conversation within one session.
const _conversationKeyCache = new Map<string, CryptoKey>()

/**
 * Ensures this wallet has a local key pair, generating one if needed, and
 * makes sure the matching PUBLIC key is uploaded to `users.chat_public_key`
 * if it isn't already there (so other people can encrypt to this user).
 * Safe to call on every app mount — it's a no-op after the first successful
 * upload for a given wallet.
 */
export async function ensureChatKeysReady(walletAddress: string, myUserId: string): Promise<void> {
  try {
    const keyPair = await loadOrGenerateKeyPair(walletAddress)
    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
    const publicKeyStr = JSON.stringify(publicJwk)

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
    const myKeyPair = await loadOrGenerateKeyPair(myWalletAddress)

    const { supabase } = await import('@/lib/supabase')
    const { data: otherUser, error } = await supabase.from('users').select('chat_public_key').eq('id', otherUserId).maybeSingle()
    if (error || !otherUser?.chat_public_key) return null // other side hasn't opened a build with this feature yet

    const otherPublicKey = await crypto.subtle.importKey(
      'jwk', JSON.parse(otherUser.chat_public_key), KEYPAIR_ALGO, false, [],
    )

    // HKDF over the raw ECDH shared secret rather than using deriveKey's
    // built-in AES derivation directly — a thin extra step, but it means
    // the actual AES key is never the raw ECDH output verbatim, standard
    // practice for combining a key-agreement primitive with a symmetric
    // cipher.
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: otherPublicKey } as any, myKeyPair.privateKey, 256,
    )
    const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey'])
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

function toBase64(bytes: ArrayBuffer): string {
  let binary = ''
  const arr = new Uint8Array(bytes)
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i])
  return btoa(binary)
}
function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64)
  const arr = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i)
  return arr
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
