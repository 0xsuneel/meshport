/**
 * MeshPort Security Utils
 * - hashPasscode / verifyPasscode: the 6-digit app-lock passcode, used for
 *   EVERY account (social-login and create/import alike) purely to lock
 *   the app UI and gate sensitive actions (send, reveal seed, export key).
 *   This passcode is NEVER used to derive a wallet-encryption key for
 *   social-login (Google/Email-OTP) accounts — those wallets are
 *   self-custodial, locked with a passkey / Recovery QR (lib/socialWallet.ts)
 *   and have nothing to do with this file's passcode functions.
 * - encryptPrivateKey / decryptPrivateKey / storeEncryptedKey / getEncryptedKey:
 *   passcode-derived AES-GCM private-key encryption for LOCAL, self-custodial
 *   wallets only (walletSource 'create' / 'import-seed' / 'import-privkey').
 *   restoreWallet.ts explicitly skips these for walletSource 'social-auto'.
 *
 * IMPORTANT: Salt is embedded in the stored hash string so it works across
 * devices and after localStorage clears.
 * Format: "v2:<base64-salt>:<base64-hash>"
 */

const PBKDF2_ITERATIONS = 100000          // legacy "v2"/"v2enc" records (still readable)
// Current records ("v3"/"v3enc"): 600,000 iterations — the OWASP figure for
// PBKDF2-SHA256. Six times the work per guess for anyone who copied this
// device's storage. Native WebCrypto keeps it fast on phones. Older records
// are upgraded on the next successful unlock (upgradeLegacyEncryption).
const PBKDF2_ITERATIONS_V3 = 600000
const ENC_KEY_PREFIX = 'meshport_encrypted_'
const VERIFY_PLAINTEXT = 'meshport-passcode-verify-v2'

// ─── Derive key from passcode + salt ─────────────────────────────────────────
async function deriveKey(passcode: string, salt: Uint8Array<ArrayBuffer>, usage: KeyUsage[], iterations: number = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(passcode), { name: 'PBKDF2' }, false, ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    usage
  )
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function fromBase64(str: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0)))
}

// ─── Hash passcode — salt embedded in output string ───────────────────────────
// Output format: "v2:<base64-16-byte-salt>:<base64-ciphertext>"
// This makes the hash self-contained and portable across devices.
export async function hashPasscode(passcode: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await deriveKey(passcode, salt, ['encrypt'], PBKDF2_ITERATIONS_V3)
  const iv = new Uint8Array(12) // fixed IV — deterministic for same key
  const enc = new TextEncoder()
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(VERIFY_PLAINTEXT)
  )
  return `v3:${toBase64(salt)}:${toBase64(new Uint8Array(ciphertext))}`
}

// ─── Brute-force lockout for the app-lock passcode ───────────────────────────
// /cso finding: verifyPasscode() had no attempt limiting at all — a script
// with devtools/localStorage access could exhaust all 10^6 six-digit codes
// well within an hour (each PBKDF2-100k check is single-digit milliseconds).
// State is per-device (localStorage), same threat model as the passcode hash
// itself: this stops a scripted brute force, not someone who has already
// fully compromised the device.
const LOCKOUT_KEY = 'meshport_passcode_lockout'
const LOCKOUT_THRESHOLD = 5          // failures allowed before the first lockout
const LOCKOUT_BASE_MS = 30_000       // 30s, doubling per subsequent lockout
const LOCKOUT_MAX_MS = 15 * 60_000   // capped at 15 minutes

interface LockoutState { failCount: number; lockedUntil: number }

function readLockoutState(): LockoutState {
  try {
    const raw = localStorage.getItem(LOCKOUT_KEY)
    if (!raw) return { failCount: 0, lockedUntil: 0 }
    const parsed = JSON.parse(raw)
    return { failCount: Number(parsed.failCount) || 0, lockedUntil: Number(parsed.lockedUntil) || 0 }
  } catch { return { failCount: 0, lockedUntil: 0 } }
}
function writeLockoutState(state: LockoutState): void {
  try { localStorage.setItem(LOCKOUT_KEY, JSON.stringify(state)) } catch { /* storage blocked */ }
}

/** Milliseconds remaining before the next passcode attempt is allowed (0 if not locked). */
export function getPasscodeLockoutRemainingMs(): number {
  const { lockedUntil } = readLockoutState()
  return Math.max(0, lockedUntil - Date.now())
}

/**
 * Clears the passcode lockout. Callers must only invoke this after a
 * check at least as strong as the passcode itself — e.g. a successful
 * platform biometric assertion (Face ID / fingerprint), which recovers the
 * real passcode via a device-bound credential rather than guessing it, and
 * so isn't subject to the brute-force threat this lockout defends against.
 * Never call this from a passcode-guessing path.
 */
export function clearPasscodeLockout(): void {
  writeLockoutState({ failCount: 0, lockedUntil: 0 })
}

// ─── Verify passcode against stored hash ─────────────────────────────────────
export async function verifyPasscode(passcode: string, storedHash: string): Promise<boolean> {
  const lockout = readLockoutState()
  if (lockout.lockedUntil > Date.now()) return false

  const result = await verifyPasscodeUnthrottled(passcode, storedHash)

  if (result) {
    writeLockoutState({ failCount: 0, lockedUntil: 0 })
  } else {
    const failCount = lockout.failCount + 1
    let lockedUntil = 0
    if (failCount >= LOCKOUT_THRESHOLD) {
      const lockoutsPast = failCount - LOCKOUT_THRESHOLD
      const durationMs = Math.min(LOCKOUT_BASE_MS * 2 ** lockoutsPast, LOCKOUT_MAX_MS)
      lockedUntil = Date.now() + durationMs
    }
    writeLockoutState({ failCount, lockedUntil })
  }
  return result
}

async function verifyPasscodeUnthrottled(passcode: string, storedHash: string): Promise<boolean> {
  try {

    // v2 format: "v2:<salt>:<hash>" — portable, works across devices
    if (storedHash.startsWith('v2:') || storedHash.startsWith('v3:')) {
      const parts = storedHash.split(':')
      if (parts.length !== 3) return false
      const salt = fromBase64(parts[1])
      const key = await deriveKey(passcode, salt, ['encrypt'], parts[0] === 'v3' ? PBKDF2_ITERATIONS_V3 : PBKDF2_ITERATIONS)
      const iv = new Uint8Array(12)
      const enc = new TextEncoder()
      const expected = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(VERIFY_PLAINTEXT))
      const expectedB64 = toBase64(new Uint8Array(expected))
      const correct = expectedB64 === parts[2]
      return correct
    }

    // Legacy v1 format (old hashes that used localStorage salt)
    // Try with localStorage salt as fallback
    const legacySalt = localStorage.getItem('meshport_passcode_salt')
    if (legacySalt) {
      const salt = new Uint8Array(JSON.parse(legacySalt))
      const key = await deriveKey(passcode, salt, ['encrypt'])
      const iv = new Uint8Array(12)
      const enc = new TextEncoder()
      // Try both old and new plaintext
      for (const pt of ['meshport-passcode-verify', VERIFY_PLAINTEXT]) {
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(pt))
        if (toBase64(new Uint8Array(ciphertext)) === storedHash) {
          return true
        }
      }
    }

    // Last resort: plain text comparison (very old stored passcodes)
    return passcode === storedHash

  } catch (e) {
    console.error('[Security] verifyPasscode error:', e)
    return false
  }
}

// ─── Encrypt private key with passcode ───────────────────────────────────────
// Output format: "v2enc:<base64-salt>:<base64-iv+ciphertext>"
export async function encryptPrivateKey(privateKey: string, passcode: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passcode, salt, ['encrypt'], PBKDF2_ITERATIONS_V3)
  const enc = new TextEncoder()
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(privateKey))
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv); combined.set(new Uint8Array(ciphertext), iv.length)
  return `v3enc:${toBase64(salt)}:${toBase64(combined)}`
}

/** Decrypt private key with passcode */
export async function decryptPrivateKey(encrypted: string, passcode: string): Promise<string | null> {
  try {
    // Device-bound copy (see "Device binding" below): open the outer layer
    // with this device's key first, then the passcode layer as usual.
    if (encrypted.startsWith(DEVICE_PREFIX)) {
      const inner = await unwrapFromDevice(encrypted)
      if (inner == null) return null
      encrypted = inner
    }
    let salt: Uint8Array<ArrayBuffer>
    let combined: Uint8Array<ArrayBuffer>
    let iterations = PBKDF2_ITERATIONS

    if (encrypted.startsWith('v2enc:') || encrypted.startsWith('v3enc:')) {
      const parts = encrypted.split(':')
      if (parts.length !== 3) return null
      salt = fromBase64(parts[1])
      combined = fromBase64(parts[2])
      if (parts[0] === 'v3enc') iterations = PBKDF2_ITERATIONS_V3
    } else {
      // Legacy format: used localStorage salt
      const legacySalt = localStorage.getItem('meshport_passcode_salt')
      if (!legacySalt) return null
      salt = new Uint8Array(JSON.parse(legacySalt))
      combined = fromBase64(encrypted)
    }

    const key = await deriveKey(passcode, salt, ['decrypt'], iterations)
    const iv = combined.slice(0, 12)
    const ciphertext = combined.slice(12)
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    return new TextDecoder().decode(plaintext)
  } catch { return null }
}

export function storeEncryptedKey(walletAddress: string, encryptedKey: string) {
  localStorage.setItem(ENC_KEY_PREFIX + walletAddress.toLowerCase(), encryptedKey)
  void bindWalletToDevice(walletAddress)
}

export function getEncryptedKey(walletAddress: string): string | null {
  return localStorage.getItem(ENC_KEY_PREFIX + walletAddress.toLowerCase())
}

// ─── Encrypted mnemonic storage (create / import-seed wallets only) ─────────
// Security-audit finding: the BIP-39 recovery phrase used to be persisted in
// PLAIN TEXT, via useAuthStore's Zustand `persist` middleware (see
// store/index.ts's old `partialize`, which included the raw `mnemonic`
// field) -- Zustand's default persist just JSON.stringifies state into
// localStorage with no encryption step. That's the wallet's master secret:
// unlike the private key (already properly AES-GCM encrypted via
// encryptPrivateKey/storeEncryptedKey above), a leaked mnemonic gives an
// attacker every current AND future address/key for this wallet, forever,
// independent of anything MeshPort does afterward. Any XSS anywhere on the
// page, a malicious browser extension with storage access, or physical
// access to an unlocked browser profile could read it directly with
// `localStorage.getItem('meshport-auth-v4')` -- no brute-forcing needed.
//
// Fix: encrypt/decrypt exactly the same way the private key already is
// (same PBKDF2-derived AES-GCM scheme, same deriveKey() above) -- these are
// thin, clearly-named wrappers around encryptPrivateKey/decryptPrivateKey
// rather than new crypto, so the encryption itself is exactly as
// battle-tested as the private-key path already was. Stored under its own
// localStorage key (never inside the Zustand-persisted state), and the raw
// mnemonic is no longer part of `partialize` at all -- see store/index.ts.
export const encryptMnemonic = encryptPrivateKey
export const decryptMnemonic = decryptPrivateKey

const ENC_MNEMONIC_PREFIX = 'meshport_encrypted_mnemonic_'

export function storeEncryptedMnemonic(walletAddress: string, encryptedMnemonic: string) {
  localStorage.setItem(ENC_MNEMONIC_PREFIX + walletAddress.toLowerCase(), encryptedMnemonic)
  void bindWalletToDevice(walletAddress)
}

export function getEncryptedMnemonic(walletAddress: string): string | null {
  return localStorage.getItem(ENC_MNEMONIC_PREFIX + walletAddress.toLowerCase())
}

// ─── Session-scoped private key cache (import-privkey wallets only) ──────────
// import-privkey wallets have no mnemonic, so a page refresh has nothing to
// silently re-derive the key from — the only way back is decrypting the
// locally-stored ciphertext with the user's passcode (see restoreWallet.ts
// step 3), which is why those wallets used to re-prompt for the passcode on
// EVERY refresh, not just after a real gap in the session.
//
// SECURITY IMPROVEMENT: the raw private key was previously cached in plain
// text in sessionStorage, which is accessible to any script on the page
// (XSS, a compromised dependency) via `sessionStorage.getItem(key)`. The
// improved strategy is:
//   1. Primary: in-memory map (zero storage footprint — cleared on tab close
//      or page reload automatically). XSS in the same page load can still
//      read JS module scope, but this removes the persistent sessionStorage
//      string that survives a devtools open or a storage inspector.
//   2. Fallback for cross-reload persistence: the key is device-wrapped
//      (AES-GCM under the non-extractable IndexedDB key, same layer as
//      bindWalletToDevice) before being written to sessionStorage. A copied
//      sessionStorage dump is useless without the exact IndexedDB key from
//      this browser, matching the protection the locally-stored encrypted key
//      already has. sessionStorage — not localStorage — is still deliberate:
//      cleared when the tab/window closes. App.tsx clears it on 'offline'.
//   3. On any IndexedDB error, fall back to the previous plain-text
//      sessionStorage behaviour rather than silently losing the cache and
//      forcing a passcode prompt on every single interaction.
const SESSION_PK_PREFIX = 'meshport_session_pk_'

// In-memory primary cache — never serialised anywhere. Cleared automatically
// when the page/tab unloads.
const _sessionPkMemory = new Map<string, string>()

export async function cacheSessionPrivateKey(walletAddress: string, privateKey: string): Promise<void> {
  const key = walletAddress.toLowerCase()
  _sessionPkMemory.set(key, privateKey)
  // Write a device-wrapped copy to sessionStorage so a same-tab reload can
  // recover without a passcode prompt.
  try {
    const wrapped = await wrapForDevice(privateKey)
    sessionStorage.setItem(SESSION_PK_PREFIX + key, wrapped)
  } catch {
    // IndexedDB unavailable or no device key yet — write plain text as last
    // resort, same as the original behaviour. The in-memory copy above still
    // gives better safety within the current page load.
    try { sessionStorage.setItem(SESSION_PK_PREFIX + key, privateKey) } catch {}
  }
}

export async function getSessionPrivateKey(walletAddress: string): Promise<string | null> {
  const key = walletAddress.toLowerCase()
  // Fast path: in-memory hit.
  const memVal = _sessionPkMemory.get(key)
  if (memVal) return memVal
  // Reload path: unwrap from sessionStorage.
  try {
    const stored = sessionStorage.getItem(SESSION_PK_PREFIX + key)
    if (!stored) return null
    let plain: string | null = null
    if (stored.startsWith(DEVICE_PREFIX)) {
      plain = await unwrapFromDevice(stored)
    } else {
      // Legacy plain-text entry written by an older session — accept it.
      plain = stored
    }
    if (plain) _sessionPkMemory.set(key, plain)
    return plain
  } catch { return null }
}

/** Clears one wallet's cached key, or every cached key when no address is given (e.g. on 'offline'). */
export function clearSessionPrivateKey(walletAddress?: string | null) {
  if (walletAddress) {
    _sessionPkMemory.delete(walletAddress.toLowerCase())
    try { sessionStorage.removeItem(SESSION_PK_PREFIX + walletAddress.toLowerCase()) } catch {}
  } else {
    _sessionPkMemory.clear()
    try {
      Object.keys(sessionStorage)
        .filter(k => k.startsWith(SESSION_PK_PREFIX))
        .forEach(k => sessionStorage.removeItem(k))
    } catch {}
  }
}


// ─── Device binding (create / import wallets) ───────────────────────────────
// The saved wallet key and recovery phrase are encrypted with the 6-digit
// passcode. On their own, a copy of this browser's storage could be opened
// by simply trying all 1,000,000 codes. Device binding adds an outer layer
// with a random AES key that is NON-EXTRACTABLE and kept in IndexedDB: no
// script can read its bytes, so a copied localStorage value is useless
// without this exact browser.
//
// The cost: if this browser's IndexedDB is ever wiped while localStorage
// survives, the saved copy can't be opened on this device any more — the
// wallet is then restored from its recovery phrase / private key (funds are
// on-chain and unaffected). That's why binding only happens once the owner
// has a backup: after creating a wallet (the recovery-phrase word check),
// after importing one (they typed it in), or after "Mark as Verified".
const DEVICE_PREFIX = 'dv1:'
const BACKUP_OK_PREFIX = 'meshport_backup_ok_'
const DEVICE_DB = 'meshport-device'
const DEVICE_STORE = 'keys'
const DEVICE_KEY_ID = 'wallet-wrap-v1'

function deviceDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DEVICE_DB, 1)
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(DEVICE_STORE)) req.result.createObjectStore(DEVICE_STORE) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function getDeviceKey(create: boolean): Promise<CryptoKey | null> {
  const db = await deviceDb()
  try {
    const existing = await new Promise<CryptoKey | null>((resolve, reject) => {
      const r = db.transaction(DEVICE_STORE, 'readonly').objectStore(DEVICE_STORE).get(DEVICE_KEY_ID)
      r.onsuccess = () => resolve((r.result as CryptoKey) ?? null); r.onerror = () => reject(r.error)
    })
    if (existing || !create) return existing
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DEVICE_STORE, 'readwrite'); tx.objectStore(DEVICE_STORE).put(key, DEVICE_KEY_ID)
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
    })
    return key
  } finally { db.close() }
}
async function wrapForDevice(inner: string): Promise<string> {
  const key = await getDeviceKey(true)
  if (!key) throw new Error('no device key')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(inner))
  return `${DEVICE_PREFIX}${toBase64(iv)}:${toBase64(new Uint8Array(ct))}`
}
async function unwrapFromDevice(wrapped: string): Promise<string | null> {
  try {
    const [ivB64, ctB64] = wrapped.slice(DEVICE_PREFIX.length).split(':')
    const key = await getDeviceKey(false)
    if (!key) return null
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(ivB64) }, key, fromBase64(ctB64))
    return new TextDecoder().decode(pt)
  } catch { return null }
}

/**
 * Seal / open a small secret with this browser's non-extractable device key
 * (the same layer as wallet device binding above). Used for the chat
 * identity so encrypted chats open straight away after a reload or a tab
 * Android discarded, without exposing the wallet key. null when IndexedDB
 * is unavailable or the device key is gone.
 */
export async function sealForDevice(secret: string): Promise<string | null> {
  try { return typeof indexedDB === 'undefined' ? null : await wrapForDevice(secret) } catch { return null }
}
export async function openFromDevice(sealed: string): Promise<string | null> {
  if (typeof indexedDB === 'undefined' || !sealed.startsWith(DEVICE_PREFIX)) return null
  return unwrapFromDevice(sealed)
}

/**
 * The owner has a backup of this wallet (recovery phrase / private key).
 * Resolves once the device layer is on the saved key and phrase — wallet
 * setup awaits it so closing the page right after can't leave them unbound.
 */
export function markWalletBackedUp(walletAddress: string): Promise<void> {
  try { localStorage.setItem(BACKUP_OK_PREFIX + walletAddress.toLowerCase(), '1') } catch { /* storage blocked */ }
  return bindWalletToDevice(walletAddress)
}
export function isWalletBackedUp(walletAddress: string): boolean {
  try { return localStorage.getItem(BACKUP_OK_PREFIX + walletAddress.toLowerCase()) === '1' } catch { return false }
}

let bindChain: Promise<void> = Promise.resolve()
/**
 * Adds the device layer to this wallet's saved key and recovery phrase, if
 * the owner has a backup and they aren't bound yet. Safe to call any time;
 * each value is checked to open again before it replaces the original.
 */
export function bindWalletToDevice(walletAddress: string): Promise<void> {
  bindChain = bindChain.then(async () => {
    if (typeof indexedDB === 'undefined' || !isWalletBackedUp(walletAddress)) return
    for (const prefix of [ENC_KEY_PREFIX, ENC_MNEMONIC_PREFIX]) {
      const id = prefix + walletAddress.toLowerCase()
      try {
        const v = localStorage.getItem(id)
        if (!v || v.startsWith(DEVICE_PREFIX)) continue
        const wrapped = await wrapForDevice(v)
        if ((await unwrapFromDevice(wrapped)) !== v) continue // never replace with something that doesn't open
        if (localStorage.getItem(id) === v) localStorage.setItem(id, wrapped)
      } catch (e) { console.warn('[security] device binding skipped:', e instanceof Error ? e.message : e) }
    }
  })
  return bindChain
}

/**
 * True when this wallet's saved copy is device-bound but this browser no
 * longer has the device key (its site data was partly cleared) — the wallet
 * has to be restored from its recovery phrase or private key.
 */
export async function isDeviceBindingLost(walletAddress: string): Promise<boolean> {
  try {
    const v = localStorage.getItem(ENC_KEY_PREFIX + walletAddress.toLowerCase())
    if (!v || !v.startsWith(DEVICE_PREFIX)) return false
    return (await unwrapFromDevice(v)) == null
  } catch { return false }
}

// ─── Upgrade legacy (100k-iteration) records after a correct passcode ───────
/**
 * Re-encrypts this wallet's stored key and recovery phrase with the current
 * (600k-iteration) scheme, keeping any device binding, and returns a new
 * passcode hash if the stored one is the legacy format (the caller saves it).
 * Safe to call on every unlock — it does nothing once everything is current.
 */
export async function upgradeLegacyEncryption(walletAddress: string | null, passcode: string, storedHash: string | null): Promise<string | null> {
  const isLegacyBlob = async (v: string | null) => {
    if (!v) return false
    if (v.startsWith(DEVICE_PREFIX)) {
      const inner = await unwrapFromDevice(v)
      return !!inner && !inner.startsWith('v3enc:')
    }
    return !v.startsWith('v3enc:')
  }
  try {
    if (walletAddress) {
      const pairs: Array<[() => string | null, (v: string) => void]> = [
        [() => getEncryptedKey(walletAddress), v => storeEncryptedKey(walletAddress, v)],
        [() => getEncryptedMnemonic(walletAddress), v => storeEncryptedMnemonic(walletAddress, v)],
      ]
      for (const [get, put] of pairs) {
        const current = get()
        if (!(await isLegacyBlob(current))) continue
        const plain = await decryptPrivateKey(current!, passcode)
        if (!plain) continue
        let upgraded = await encryptPrivateKey(plain, passcode)
        if (current!.startsWith(DEVICE_PREFIX)) upgraded = await wrapForDevice(upgraded)
        put(upgraded)
      }
    }
  } catch { /* keep the old copy — it still opens */ }
  if (storedHash && !storedHash.startsWith('v3:')) {
    try { return await hashPasscode(passcode) } catch { return null }
  }
  return null
}
