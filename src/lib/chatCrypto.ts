// src/lib/chatCrypto.ts
//
// ── End-to-end encrypted chat (messages, photos, files) ──────────────────
//
// IDENTITY — one per person, on every device.
//   Each user's chat identity is an X25519 key pair DERIVED from their wallet
//   private key (deriveMyChatIdentity). Logging in on any device restores the
//   wallet (Google/email accounts with their passkey or Recovery QR, others
//   from the recovery phrase / private key), and with it the exact same chat
//   identity, so every
//   device the user signs in on reads their whole chat history, old and new.
//   Only the PUBLIC key is uploaded (users.chat_public_key), together with
//   a signature by the WALLET over it (users.chat_key_sig).
//
// SIGNED KEYS — the server can't swap them.
//   A key is used only if its signature recovers to that user's wallet
//   address (which no client can change). Someone with database access who
//   replaces a key can't produce that signature, so the swapped key is
//   ignored and nothing gets sealed for it — messages wait (e2e:q2) instead.
//   Like WhatsApp's safety numbers, but checked automatically, because the
//   identity is already the wallet.
//
// REMEMBERED IDENTITIES — "security info changed".
//   The signature ties a key to the wallet address the server reports. To
//   also catch that address being changed, this device remembers each
//   contact's wallet + key the first time it sees them signed (like
//   WhatsApp's security code). If either later differs, the new key isn't
//   used — messages wait and Pay is held — until the user confirms in the
//   chat (trustNewIdentity). A user's real key never changes on its own:
//   it's derived from their wallet.
//
// EVERY MESSAGE CARRIES ITS OWN KEY — format "e2e:v2:".
//   For each message (and each photo/file) a fresh random 256-bit key K is
//   made, the content is sealed with AES-256-GCM under K, and K itself is
//   sealed for the two people in the chat with a key from X25519(sender,
//   recipient) — which both of them, and only they, can recompute. The
//   message also names the sender's and recipient's public keys, so reading
//   it never depends on looking anyone's key up on the server (that lookup
//   failing, e.g. an account still showing an outdated key, was what made
//   messages show as locked). One message's key opens that message only.
//
//   This is not WhatsApp's Signal protocol: WhatsApp gives every DEVICE its
//   own keys, so a new device does not get old history unless the old phone
//   transfers it. MeshPort ties chat to the WALLET instead, which is what
//   lets any signed-in device read everything. The trade-off: whoever holds
//   the wallet key can read that wallet's chats (as they can move its funds).
//
// WAITING FOR THE RECIPIENT — format "e2e:q2:".
//   Someone who hasn't signed in since chat encryption started has no key to
//   seal for. Nothing is ever sent readable: the message is sealed for the
//   SENDER's own identity (same e2e:v2 layout, recipient key = sender key),
//   so only the sender can open it — not the server, not an admin. Once the
//   recipient signs in and publishes a key, the sender's app (any device)
//   re-seals it for both of them as e2e:v2 (resealWaitingMessages); the
//   database only lets the sender make exactly that q2 → v2 change.
//
// OLDER FORMATS — still readable, never sent any more.
//   "e2e:v1:" messages used one shared key per conversation. They are still
//   decrypted (from the same identities), so no history is lost. Text with
//   no prefix was sent before encryption existed and is shown as is.
//
// KEY ON THIS DEVICE.
//   The wallet key lives in memory only, so after a reload — or a tab Android
//   discarded — chat used to wait for it (for created/imported wallets: until
//   the passcode was entered) and showed every message locked meanwhile. The
//   chat identity seed (it reads chat; it can't move funds) is now also kept
//   on this device, sealed with the browser's non-extractable device key
//   (see sealForDevice in security.ts), and removed on logout.

import { x25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha256'

const AES_ALGO = { name: 'AES-GCM', length: 256 }
const V1_PREFIX = 'e2e:v1:'
const V2_PREFIX = 'e2e:v2:'
const Q2_PREFIX = 'e2e:q2:' // sealed for the sender only, waiting for the recipient's key
const MEDIA_V2_PREFIX = 'v2.'
// Domain separation — this seed is only ever a chat identity.
const CHAT_IDENTITY_INFO = new TextEncoder().encode('meshport-chat-identity-v2')
const MSG_KEY_INFO = new TextEncoder().encode('meshport-chat-msgkey-v2')

/** The placeholder shown for a message this device cannot open. */
export const LOCKED_TEXT = '🔒 Encrypted message — unable to decrypt on this device'
const BROKEN_TEXT = '🔒 Encrypted message — unable to decrypt'
/** What the recipient sees for a message still waiting to be re-sealed for them. */
export const WAITING_TEXT = '⏳ Waiting for this message — it appears when the sender is next online'

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16)
  return bytes
}
function toHex(b: Uint8Array): string { let h = ''; for (const x of b) h += x.toString(16).padStart(2, '0'); return h }
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
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

/** A published chat public key, or null for a missing / outdated (pre-X25519 JSON) one. */
function parsePublicKey(value: string | null | undefined): Uint8Array | null {
  if (!value || value.startsWith('{')) return null
  try { const k = fromBase64(value); return k.length === 32 ? k : null } catch { return null }
}

/**
 * This wallet's chat identity (X25519). Pure: the same wallet key gives the
 * same identity on every device, every time.
 */
export function deriveMyChatIdentity(walletPrivateKeyHex: string): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const walletKeyBytes = hexToBytes(walletPrivateKeyHex)
  const combined = new Uint8Array(walletKeyBytes.length + CHAT_IDENTITY_INFO.length)
  combined.set(walletKeyBytes, 0)
  combined.set(CHAT_IDENTITY_INFO, walletKeyBytes.length)
  const seed = sha256(combined)
  return { privateKey: seed, publicKey: x25519.getPublicKey(seed) }
}

// ── This device's copy of the chat identity seed ───────────────────────────
const SEED_PREFIX = 'meshport_chat_seed_'        // sessionStorage, this tab
const SEED_DEVICE_PREFIX = 'meshport_chat_seed_dv_' // localStorage, sealed to this browser
const PUB_PREFIX = 'meshport_chat_vpub_' // verified (wallet-signed) keys only

function saveSeed(walletAddress: string, seed: Uint8Array) {
  const addr = walletAddress.toLowerCase()
  try { sessionStorage.setItem(SEED_PREFIX + addr, toHex(seed)) } catch { /* storage blocked */ }
  void import('@/lib/security').then(async ({ sealForDevice }) => {
    const sealed = await sealForDevice(toHex(seed))
    if (sealed) { try { localStorage.setItem(SEED_DEVICE_PREFIX + addr, sealed) } catch { /* storage blocked */ } }
  }).catch(() => {})
}
async function loadSeed(walletAddress: string): Promise<Uint8Array | null> {
  const addr = walletAddress.toLowerCase()
  const valid = (h: string | null) => (h && /^[0-9a-f]{64}$/.test(h) ? hexToBytes(h) : null)
  try {
    const s = valid(sessionStorage.getItem(SEED_PREFIX + addr))
    if (s) return s
  } catch { /* storage blocked */ }
  try {
    const sealed = localStorage.getItem(SEED_DEVICE_PREFIX + addr)
    if (!sealed) return null
    const { openFromDevice } = await import('@/lib/security')
    const seed = valid(await openFromDevice(sealed))
    if (seed) { try { sessionStorage.setItem(SEED_PREFIX + addr, toHex(seed)) } catch { /* */ } }
    return seed
  } catch { return null }
}
/** Forget this device's chat identity (logout). */
export function clearChatSessionSeeds() {
  for (const store of [() => sessionStorage, () => localStorage]) {
    try {
      const st = store()
      for (let i = st.length - 1; i >= 0; i--) {
        const k = st.key(i)
        if (k?.startsWith(SEED_PREFIX)) st.removeItem(k)
      }
    } catch { /* storage blocked */ }
  }
  _keysCache.clear()
}

/** This wallet's chat seed: from the wallet key when unlocked, else this device's copy. */
async function getMySeed(walletAddress: string): Promise<Uint8Array | null> {
  const walletPrivateKey = (await import('@/store')).useAuthStore.getState().privateKey
  if (walletPrivateKey) {
    const seed = deriveMyChatIdentity(walletPrivateKey).privateKey
    saveSeed(walletAddress, seed)
    return seed
  }
  return loadSeed(walletAddress)
}

// ── Remembered contact identities (per device, per my wallet) ──────────────
const PIN_PREFIX = 'meshport_chat_pin_'
const CHANGED_PREFIX = 'meshport_chat_changed_'
/** Fired with { userId } when a contact's wallet or key differs from the remembered one. */
export const IDENTITY_CHANGED_EVENT = 'meshport:chat-identity-changed'
type Pin = { wallet: string; pub: string }
const pinKey = (me: string, userId: string) => `${me.toLowerCase()}:${userId}`
function readJson(key: string): Pin | null {
  try { const v = JSON.parse(localStorage.getItem(key) ?? 'null'); return v?.wallet && v?.pub ? v : null } catch { return null }
}
function writeJson(key: string, v: Pin | null) {
  try { if (v) localStorage.setItem(key, JSON.stringify(v)); else localStorage.removeItem(key) } catch { /* storage blocked */ }
}

/**
 * Checks a contact's verified wallet + key against the remembered one.
 * First sighting is remembered; a difference is recorded and reported.
 * Returns true when it may be used. (Exported for tests.)
 */
export function checkPinned(me: string, userId: string, wallet: string, pub: string): boolean {
  const k = pinKey(me, userId)
  const pin = readJson(PIN_PREFIX + k)
  const seen = { wallet: wallet.toLowerCase(), pub }
  if (!pin) { writeJson(PIN_PREFIX + k, seen); return true }
  if (pin.wallet === seen.wallet && pin.pub === seen.pub) { writeJson(CHANGED_PREFIX + k, null); return true }
  const prev = readJson(CHANGED_PREFIX + k)
  writeJson(CHANGED_PREFIX + k, seen)
  if (!prev || prev.wallet !== seen.wallet || prev.pub !== seen.pub) {
    try { window.dispatchEvent(new CustomEvent(IDENTITY_CHANGED_EVENT, { detail: { userId } })) } catch { /* no window (tests) */ }
  }
  return false
}

/** The contact's changed identity awaiting confirmation on this device, or null. */
export function changedIdentity(myWalletAddress: string, userId: string): { wallet: string } | null {
  const c = readJson(CHANGED_PREFIX + pinKey(myWalletAddress, userId))
  return c ? { wallet: c.wallet } : null
}

/** The user confirmed the contact's new security info: remember it and use it. */
export function trustNewIdentity(myWalletAddress: string, userId: string): void {
  const k = pinKey(myWalletAddress, userId)
  const c = readJson(CHANGED_PREFIX + k)
  if (c) writeJson(PIN_PREFIX + k, c)
  writeJson(CHANGED_PREFIX + k, null)
  _keysCache.delete(k)
  dropPub(userId)
}

function cachedPub(userId: string): string | null { try { return localStorage.getItem(PUB_PREFIX + userId) } catch { return null } }
function savePub(userId: string, pub: string) { try { localStorage.setItem(PUB_PREFIX + userId, pub) } catch { /* storage blocked */ } }
function dropPub(userId: string) { try { localStorage.removeItem(PUB_PREFIX + userId) } catch { /* storage blocked */ } }

/** The text a wallet signs to vouch for its chat key. */
export function chatKeyStatement(walletAddress: string, publicKeyB64: string): string {
  return `MeshPort chat key\nWallet: ${walletAddress.toLowerCase()}\nKey: ${publicKeyB64}`
}

/** True when `sig` is `walletAddress`'s signature over its chat key `publicKeyB64`. */
export async function verifyChatKey(walletAddress: string | null | undefined, publicKeyB64: string | null | undefined, sig: string | null | undefined): Promise<boolean> {
  if (!walletAddress || !publicKeyB64 || !sig || !parsePublicKey(publicKeyB64)) return false
  try {
    const { recoverMessageAddress } = await import('viem')
    const signer = await recoverMessageAddress({ message: chatKeyStatement(walletAddress, publicKeyB64), signature: sig as `0x${string}` })
    return signer.toLowerCase() === walletAddress.toLowerCase()
  } catch { return false }
}

/**
 * Publishes this wallet's chat public key to users.chat_public_key (replacing
 * a missing or outdated one). Cheap to call repeatedly — AppLayout calls it
 * on start and again whenever the wallet key unlocks.
 */
export async function ensureChatKeysReady(walletAddress: string, myUserId: string): Promise<void> {
  try {
    // Publishing needs the wallet key itself: the chat key is only trusted
    // with the wallet's signature. Called again when the wallet unlocks.
    const walletPrivateKey = (await import('@/store')).useAuthStore.getState().privateKey
    if (!walletPrivateKey) return
    const seed = deriveMyChatIdentity(walletPrivateKey).privateKey
    saveSeed(walletAddress, seed)
    const publicKeyStr = toBase64(x25519.getPublicKey(seed))
    const { privateKeyToAccount } = await import('viem/accounts')
    const pk = (walletPrivateKey.startsWith('0x') ? walletPrivateKey : '0x' + walletPrivateKey) as `0x${string}`
    const sig = await privateKeyToAccount(pk).signMessage({ message: chatKeyStatement(walletAddress, publicKeyStr) })
    const { supabase } = await import('@/lib/supabase')
    const { data: current } = await supabase.from('users').select('chat_public_key, chat_key_sig').eq('id', myUserId).maybeSingle()
    if (current?.chat_public_key === publicKeyStr && current?.chat_key_sig === sig) return
    const { error } = await supabase.from('users').update({ chat_public_key: publicKeyStr, chat_key_sig: sig }).eq('id', myUserId)
    if (error) console.error('[chatCrypto] failed to upload public key:', error.message)
  } catch (e) {
    console.error('[chatCrypto] ensureChatKeysReady failed:', e instanceof Error ? e.message : e)
  }
}

// ── Keys for one conversation ──────────────────────────────────────────────
/** What getConversationKey returns. Opaque to callers — pass it back in. */
export interface ChatKeys {
  readonly kind: 'chat-keys'
  readonly seed: Uint8Array
  readonly myPub: Uint8Array
  /** The other person's published key; null if missing/outdated (then new messages can't be sealed for them). */
  readonly otherPub: Uint8Array | null
  /** Shared key for reading old e2e:v1 messages. */
  readonly v1: CryptoKey | null
}
type AnyKey = ChatKeys | CryptoKey | null | undefined
const isChatKeys = (k: AnyKey): k is ChatKeys => !!k && (k as ChatKeys).kind === 'chat-keys'

const _keysCache = new Map<string, ChatKeys>()

async function deriveV1Key(seed: Uint8Array, otherPub: Uint8Array): Promise<CryptoKey> {
  const shared = x25519.getSharedSecret(seed, otherPub)
  const hkdf = await crypto.subtle.importKey('raw', new Uint8Array(shared), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('meshport-chat-e2e-v1') },
    hkdf, AES_ALGO, false, ['encrypt', 'decrypt'],
  )
}

/** Builds the keys for one chat from my identity seed and their public key (exported for tests). */
export async function makeChatKeys(seed: Uint8Array, otherPub: Uint8Array | null): Promise<ChatKeys> {
  return { kind: 'chat-keys', seed, myPub: x25519.getPublicKey(seed), otherPub, v1: otherPub ? await deriveV1Key(seed, otherPub) : null }
}

/**
 * This user's keys for the chat with `otherUserId`, or null when this
 * device has no chat identity yet (wallet still locked on a fresh device).
 * Messages in the new format open with these keys even if the other person's
 * published key is missing or outdated.
 */
export async function getConversationKey(myWalletAddress: string, otherUserId: string): Promise<ChatKeys | null> {
  const cacheKey = `${myWalletAddress.toLowerCase()}:${otherUserId}`
  const cached = _keysCache.get(cacheKey)
  if (cached) return cached
  try {
    const seed = await getMySeed(myWalletAddress)
    if (!seed) return null
    const { supabase } = await import('@/lib/supabase')
    // Their key, only if their wallet signed it (null otherwise, undefined on a network error).
    const fetchPub = async () => {
      const { data, error } = await supabase.from('users').select('chat_public_key, chat_key_sig, wallet_address').eq('id', otherUserId).maybeSingle()
      if (error) return undefined
      const pub = (data?.chat_public_key as string | null) ?? null
      if (!(await verifyChatKey(data?.wallet_address, pub, data?.chat_key_sig))) return null
      return checkPinned(myWalletAddress, otherUserId, data!.wallet_address as string, pub!) ? pub : null
    }
    // Remembered copy first (no network wait), confirmed in the background.
    let pubStr = cachedPub(otherUserId)
    if (pubStr && parsePublicKey(pubStr)) {
      void fetchPub().then(fresh => {
        if (fresh === undefined || fresh === pubStr) return
        if (parsePublicKey(fresh)) savePub(otherUserId, fresh as string); else dropPub(otherUserId)
        _keysCache.delete(cacheKey)
      }).catch(() => {})
    } else {
      const fresh = await fetchPub()
      pubStr = fresh ?? null
      if (parsePublicKey(pubStr)) savePub(otherUserId, pubStr as string); else dropPub(otherUserId)
    }
    const otherPub = parsePublicKey(pubStr)
    const keys = await makeChatKeys(seed, otherPub)
    // Only cache a complete answer: a missing key is looked up again next time.
    if (otherPub) _keysCache.set(cacheKey, keys)
    return keys
  } catch (e) {
    console.error('[chatCrypto] getConversationKey failed:', e instanceof Error ? e.message : e)
    return null
  }
}

// ── Per-message key: seal / open ───────────────────────────────────────────
/** The key that seals one message's own key, from X25519(me, them) bound to both public keys. */
async function wrappingKey(seed: Uint8Array, otherPub: Uint8Array, spk: Uint8Array, rpk: Uint8Array): Promise<CryptoKey> {
  const shared = x25519.getSharedSecret(seed, otherPub)
  const salt = new Uint8Array(spk.length + rpk.length); salt.set(spk, 0); salt.set(rpk, spk.length)
  const hkdf = await crypto.subtle.importKey('raw', new Uint8Array(shared), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(sha256(salt)), info: MSG_KEY_INFO }, hkdf, AES_ALGO, false, ['encrypt', 'decrypt'])
}

/** Seal `data` under a fresh per-message key; returns the parts as base64, '.'-joined. */
async function sealV2(keys: ChatKeys, data: BufferSource): Promise<{ header: string; iv: Uint8Array; ct: ArrayBuffer }> {
  // No key for the recipient yet → sealed for the sender alone (see e2e:q2).
  const otherPub = keys.otherPub ?? keys.myPub
  const raw = crypto.getRandomValues(new Uint8Array(32))
  const msgKey = await crypto.subtle.importKey('raw', raw, AES_ALGO, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, msgKey, data)
  const wrapKey = await wrappingKey(keys.seed, otherPub, keys.myPub, otherPub)
  const wiv = crypto.getRandomValues(new Uint8Array(12))
  const wk = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wiv }, wrapKey, raw)
  raw.fill(0)
  return { header: [keys.myPub, otherPub, wiv, new Uint8Array(wk)].map(toBase64).join('.'), iv, ct }
}

/** A message's own key bytes from its header, if this identity is its sender or recipient. */
async function openRawMsgKey(keys: ChatKeys, header: string[]): Promise<ArrayBuffer | null> {
  const [spk, rpk, wiv, wk] = header.map(fromBase64)
  const other = sameBytes(spk, keys.myPub) ? rpk : sameBytes(rpk, keys.myPub) ? spk : null
  if (!other) return null // sealed for a different identity
  // With their wallet-signed key known, only that key (or my own, for my
  // waiting messages) may be the other side — a message made with some
  // other key (forged by whoever controls the server) doesn't open.
  if (keys.otherPub && !sameBytes(other, keys.otherPub) && !sameBytes(other, keys.myPub)) return null
  const wrapKey = await wrappingKey(keys.seed, other, spk, rpk)
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: wiv }, wrapKey, wk)
}

/** Recover a message's own key from its header, if this identity is its sender or recipient. */
async function openMsgKey(keys: ChatKeys, header: string[]): Promise<CryptoKey | null> {
  const raw = await openRawMsgKey(keys, header)
  return raw ? crypto.subtle.importKey('raw', raw, AES_ALGO, false, ['decrypt']) : null
}

/** Re-wrap a message key header (4 parts) so the recipient in `keys` can open it too. */
async function rewrapHeader(keys: ChatKeys, header: string[]): Promise<string | null> {
  const otherPub = keys.otherPub
  if (!otherPub) return null
  const raw = await openRawMsgKey(keys, header)
  if (!raw) return null
  const wrapKey = await wrappingKey(keys.seed, otherPub, keys.myPub, otherPub)
  const wiv = crypto.getRandomValues(new Uint8Array(12))
  const wk = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wiv }, wrapKey, raw)
  new Uint8Array(raw).fill(0)
  return [keys.myPub, otherPub, wiv, new Uint8Array(wk)].map(toBase64).join('.')
}

// ── Text ───────────────────────────────────────────────────────────────────
/**
 * Encrypts text for sending. Every message gets its own key (e2e:v2). When
 * the recipient has no key yet it is sealed for the sender alone (e2e:q2)
 * and handed over later by resealWaitingMessages — never sent readable.
 * Returns the text unchanged only with no keys at all (callers must not send
 * then). A bare CryptoKey still produces the legacy e2e:v1 format (tests).
 */
export async function encryptText(plaintext: string, key: AnyKey): Promise<string> {
  if (!key) return plaintext
  if (isChatKeys(key)) {
    const { header, iv, ct } = await sealV2(key, new TextEncoder().encode(plaintext))
    return (key.otherPub ? V2_PREFIX : Q2_PREFIX) + header + '.' + toBase64(iv) + '.' + toBase64(ct)
  }
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  return V1_PREFIX + toBase64(iv.buffer) + ':' + toBase64(ciphertext)
}

/**
 * Decrypts e2e:v2 and legacy e2e:v1 text. Anything else is returned as is.
 * Never throws: a message this device can't open shows a placeholder.
 */
export async function decryptText(payload: string, key: AnyKey): Promise<string> {
  if (!isEncryptedPayload(payload)) return payload
  if (!key) return LOCKED_TEXT
  try {
    const waiting = payload.startsWith(Q2_PREFIX)
    if (payload.startsWith(V2_PREFIX) || waiting) {
      if (!isChatKeys(key)) return waiting ? WAITING_TEXT : LOCKED_TEXT
      const parts = payload.slice(V2_PREFIX.length).split('.')
      if (parts.length !== 6) return BROKEN_TEXT
      const msgKey = await openMsgKey(key, parts.slice(0, 4))
      if (!msgKey) return waiting ? WAITING_TEXT : LOCKED_TEXT
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(parts[4]) }, msgKey, fromBase64(parts[5]))
      return new TextDecoder().decode(pt)
    }
    const v1 = isChatKeys(key) ? key.v1 : key
    if (!v1) return LOCKED_TEXT
    const [ivB64, ctB64] = payload.slice(V1_PREFIX.length).split(':')
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(ivB64) }, v1, fromBase64(ctB64))
    return new TextDecoder().decode(pt)
  } catch (e) {
    console.error('[chatCrypto] decryptText failed:', e instanceof Error ? e.message : e)
    return BROKEN_TEXT
  }
}

// ── Photos & files ─────────────────────────────────────────────────────────
/**
 * Encrypts a file under its own key. `ivBase64` is what goes into the
 * message marker ([IMAGE-E:…] / [FILE-E:name:…]): for the new format it holds
 * the sealed file key too ("v2.<…>", no ':' or ']'). With no recipient key
 * yet the file key is sealed for the sender alone, like the text around it.
 * Returns the original blob with encrypted:false only with no keys at all.
 */
export async function encryptBlob(blob: Blob, key: AnyKey): Promise<{ blob: Blob; ivBase64: string | null; encrypted: boolean }> {
  if (!key) return { blob, ivBase64: null, encrypted: false }
  const plainBytes = await blob.arrayBuffer()
  if (isChatKeys(key)) {
    const { header, iv, ct } = await sealV2(key, plainBytes)
    return { blob: new Blob([ct]), ivBase64: MEDIA_V2_PREFIX + header + '.' + toBase64(iv), encrypted: true }
  }
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBytes)
  return { blob: new Blob([ciphertext]), ivBase64: toBase64(iv.buffer), encrypted: true }
}

/** Decrypts a downloaded file (new or legacy format). Bytes pass through when it was never encrypted. */
export async function decryptBlob(encryptedBytes: ArrayBuffer, ivBase64: string | null, key: AnyKey): Promise<Blob> {
  if (!ivBase64 || !key) return new Blob([encryptedBytes])
  try {
    if (ivBase64.startsWith(MEDIA_V2_PREFIX)) {
      if (!isChatKeys(key)) throw new Error('no chat identity')
      const parts = ivBase64.slice(MEDIA_V2_PREFIX.length).split('.')
      if (parts.length !== 5) throw new Error('bad file header')
      const msgKey = await openMsgKey(key, parts.slice(0, 4))
      if (!msgKey) throw new Error('file sealed for another identity')
      return new Blob([await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(parts[4]) }, msgKey, encryptedBytes)])
    }
    const v1 = isChatKeys(key) ? key.v1 : key
    if (!v1) throw new Error('no key for legacy file')
    return new Blob([await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(ivBase64) }, v1, encryptedBytes)])
  } catch (e) {
    console.error('[chatCrypto] decryptBlob failed:', e instanceof Error ? e.message : e)
    throw e // caller shows a "couldn't decrypt this file" state — see ChatPage.tsx
  }
}

export function isEncryptedPayload(payload: string): boolean {
  return payload.startsWith(V2_PREFIX) || payload.startsWith(Q2_PREFIX) || payload.startsWith(V1_PREFIX)
}

/** Sealed for the sender only, still waiting for the recipient's key. */
export function isWaitingPayload(payload: string): boolean {
  return payload.startsWith(Q2_PREFIX)
}

/**
 * Hand a waiting (e2e:q2) message over: re-seal it for sender and recipient
 * as e2e:v2, including the keys of any photos/files it carries (the files
 * themselves don't change). null if the recipient still has no key or this
 * identity didn't send it.
 */
export async function resealWaiting(payload: string, keys: ChatKeys): Promise<string | null> {
  if (!payload.startsWith(Q2_PREFIX) || !keys.otherPub) return null
  const plain = await decryptText(payload, keys)
  if (plain === WAITING_TEXT || plain === LOCKED_TEXT || plain === BROKEN_TEXT) return null
  // Media markers: [IMAGE-E:v2.<spk>.<rpk>.<wiv>.<wk>.<iv>](…) / [FILE-E:name:v2.…](…)
  let out = plain
  for (const m of plain.matchAll(/v2\.([A-Za-z0-9+/=]+)\.([A-Za-z0-9+/=]+)\.([A-Za-z0-9+/=]+)\.([A-Za-z0-9+/=]+)\.([A-Za-z0-9+/=]+)(?=\])/g)) {
    const header = await rewrapHeader(keys, [m[1], m[2], m[3], m[4]])
    if (!header) return null
    out = out.replace(m[0], MEDIA_V2_PREFIX + header + '.' + m[5])
  }
  const sealed = await encryptText(out, keys)
  return sealed.startsWith(V2_PREFIX) ? sealed : null
}

/**
 * Re-seal this user's waiting messages for every recipient who now has a
 * key. Runs from AppLayout on start, on unlock and every few minutes; cheap
 * when there's nothing waiting (one indexed query).
 */
export async function resealWaitingMessages(walletAddress: string, myUserId: string): Promise<number> {
  try {
    const { supabase } = await import('@/lib/supabase')
    const { data: rows } = await supabase.from('messages')
      .select('id, conversation_id, content')
      .eq('sender_id', myUserId).like('content', Q2_PREFIX + '%').limit(200)
    if (!rows?.length) return 0
    const convIds = [...new Set(rows.map(r => r.conversation_id as string))]
    const { data: convs } = await supabase.from('conversations')
      .select('id, participant_a, participant_b').in('id', convIds)
    let done = 0
    for (const c of convs ?? []) {
      const other = c.participant_a === myUserId ? c.participant_b : c.participant_a
      _keysCache.delete(`${walletAddress.toLowerCase()}:${other}`)
      dropPub(other) // re-read: their key may have just been published
      const keys = await getConversationKey(walletAddress, other)
      if (!keys?.otherPub) continue
      for (const r of rows.filter(r => r.conversation_id === c.id)) {
        const sealed = await resealWaiting(r.content as string, keys)
        if (!sealed) continue
        const { error } = await supabase.from('messages').update({ content: sealed }).eq('id', r.id)
        if (!error) done++
      }
    }
    return done
  } catch (e) {
    console.error('[chatCrypto] resealWaitingMessages failed:', e instanceof Error ? e.message : e)
    return 0
  }
}
