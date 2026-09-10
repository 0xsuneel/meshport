/**
 * ArcPay Security Utils
 * - hashPasscode / verifyPasscode: the 6-digit app-lock passcode, used for
 *   EVERY account (social-login and create/import alike) purely to lock
 *   the app UI and gate sensitive actions (send, reveal seed, export key).
 *   This passcode is NEVER used to derive a wallet-encryption key for
 *   social-login (Google/Email-OTP) accounts — those wallets are
 *   envelope-encrypted server-side (see supabase/functions/wallet-key)
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

const PBKDF2_ITERATIONS = 100000
const ENC_KEY_PREFIX = 'meshport_encrypted_'
const VERIFY_PLAINTEXT = 'meshport-passcode-verify-v2'

// ─── Derive key from passcode + salt ─────────────────────────────────────────
async function deriveKey(passcode: string, salt: Uint8Array<ArrayBuffer>, usage: KeyUsage[]): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(passcode), { name: 'PBKDF2' }, false, ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
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
  const key = await deriveKey(passcode, salt, ['encrypt'])
  const iv = new Uint8Array(12) // fixed IV — deterministic for same key
  const enc = new TextEncoder()
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(VERIFY_PLAINTEXT)
  )
  return `v2:${toBase64(salt)}:${toBase64(new Uint8Array(ciphertext))}`
}

// ─── Verify passcode against stored hash ─────────────────────────────────────
export async function verifyPasscode(passcode: string, storedHash: string): Promise<boolean> {
  try {

    // v2 format: "v2:<salt>:<hash>" — portable, works across devices
    if (storedHash.startsWith('v2:')) {
      const parts = storedHash.split(':')
      if (parts.length !== 3) return false
      const salt = fromBase64(parts[1])
      const storedCiphertext = fromBase64(parts[2])
      const key = await deriveKey(passcode, salt, ['encrypt'])
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
  const key = await deriveKey(passcode, salt, ['encrypt'])
  const enc = new TextEncoder()
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(privateKey))
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv); combined.set(new Uint8Array(ciphertext), iv.length)
  return `v2enc:${toBase64(salt)}:${toBase64(combined)}`
}

/** Decrypt private key with passcode */
export async function decryptPrivateKey(encrypted: string, passcode: string): Promise<string | null> {
  try {
    let salt: Uint8Array<ArrayBuffer>
    let combined: Uint8Array<ArrayBuffer>

    if (encrypted.startsWith('v2enc:')) {
      const parts = encrypted.split(':')
      if (parts.length !== 3) return null
      salt = fromBase64(parts[1])
      combined = fromBase64(parts[2])
    } else {
      // Legacy format: used localStorage salt
      const legacySalt = localStorage.getItem('meshport_passcode_salt')
      if (!legacySalt) return null
      salt = new Uint8Array(JSON.parse(legacySalt))
      combined = fromBase64(encrypted)
    }

    const key = await deriveKey(passcode, salt, ['decrypt'])
    const iv = combined.slice(0, 12)
    const ciphertext = combined.slice(12)
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    return new TextDecoder().decode(plaintext)
  } catch { return null }
}

export function storeEncryptedKey(walletAddress: string, encryptedKey: string) {
  localStorage.setItem(ENC_KEY_PREFIX + walletAddress.toLowerCase(), encryptedKey)
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
// This cache trades a small amount of exposure for that convenience: once
// the key is decrypted (by whatever means), it's mirrored in sessionStorage
// so subsequent refreshes in the SAME browser tab session can skip the
// prompt. sessionStorage — not localStorage — is deliberate: it's wiped the
// moment the tab/window actually closes, and App.tsx additionally clears it
// on the browser's 'offline' event so a genuine disconnect-and-return also
// forces the passcode again, matching the "only ask again after being away"
// behavior. It does NOT protect against an XSS running on the page while
// the tab is open (nothing in browser storage can), so this is a real
// security/convenience tradeoff, not a free win — worth keeping in mind
// since this cache holds the raw private key itself.
const SESSION_PK_PREFIX = 'meshport_session_pk_'

export function cacheSessionPrivateKey(walletAddress: string, privateKey: string) {
  try { sessionStorage.setItem(SESSION_PK_PREFIX + walletAddress.toLowerCase(), privateKey) } catch {}
}

export function getSessionPrivateKey(walletAddress: string): string | null {
  try { return sessionStorage.getItem(SESSION_PK_PREFIX + walletAddress.toLowerCase()) } catch { return null }
}

/** Clears one wallet's cached key, or every cached key when no address is given (e.g. on 'offline'). */
export function clearSessionPrivateKey(walletAddress?: string | null) {
  try {
    if (walletAddress) {
      sessionStorage.removeItem(SESSION_PK_PREFIX + walletAddress.toLowerCase())
    } else {
      Object.keys(sessionStorage)
        .filter(k => k.startsWith(SESSION_PK_PREFIX))
        .forEach(k => sessionStorage.removeItem(k))
    }
  } catch {}
}
