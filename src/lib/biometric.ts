import { markPasscodeVerified, isPasscodeVerifiedThisSession } from './security'
/**
 * lib/biometric.ts
 *
 * Real WebAuthn platform-authenticator integration: Face ID / Touch ID /
 * Android fingerprint / Windows Hello unlock of the passcode, entirely on
 * this device.
 *
 * ── What this actually does ─────────────────────────────────────────────
 * navigator.credentials.create() registers a real platform credential (the
 * OS enrollment prompt); navigator.credentials.get() later re-triggers the
 * same OS prompt to unlock. MeshPort never sees fingerprint or face data -
 * only the authenticator's result.
 *
 * ── How the stored passcode is protected ────────────────────────────────
 * The passcode is sealed (AES-GCM) with a key derived from the WebAuthn
 * "PRF" extension: a secret the authenticator computes from the credential
 * and a per-record salt, and only hands out after user verification. The
 * key is never stored, so reading this browser's storage gets an attacker
 * nothing usable. There is deliberately NO fallback: a device/browser
 * without PRF simply doesn't get biometric unlock (passcode only) - a copy
 * sealed any other way could be read by script without a fingerprint.
 *
 * ── Registration sequence (registerBiometric) ───────────────────────────
 *  1. create() with prf.eval - some authenticators return the PRF output
 *     right away, many only report `prf.enabled: true` (Chrome + Google
 *     Password Manager, several Android/Windows builds). `enabled: false`
 *     means no PRF: the new credential is discarded, nothing is saved.
 *  2. get() for that credential with the SAME salt - this yields the PRF
 *     output when create() didn't, and in every case is the verification
 *     test: it is exactly the unlock path, so a success here means unlock
 *     will work after a refresh or PWA restart. If create() did return an
 *     output, the two must be identical.
 *  3. Seal the passcode, decrypt it again, compare - then write the
 *     credential id and the sealed record together; if either write fails
 *     both are removed. Any failure after create() discards the credential
 *     (signalUnknownCredential, where the browser supports it).
 *  The caller turns the biometric setting on only after all of that.
 *  If step 2's prompt can't open by itself (Safari allows one WebAuthn
 *  prompt per tap), the result is 'needs-confirm' and the page asks for one
 *  more tap (confirmBiometricRegistration) or discards it on Skip
 *  (abandonBiometricRegistration).
 *
 * ── Biometric vs. "user verification" ──────────────────────────────────
 * userVerification: 'required' is the strongest a website can ask for, but
 * it means "the device verified its owner", not "a biometric was used":
 * Windows Hello accepts its PIN, Android its screen-lock PIN/pattern, and
 * iOS/macOS the device passcode after failed Face ID / Touch ID. No web API
 * can require biometric-only, so the copy says so instead of promising it.
 *
 * ── Relying party / origin ───────────────────────────────────────────────
 * rp.id is left to the browser's default: the current hostname. That is
 * meshport.xyz in production and the deployment's own host on Vercel
 * previews / localhost, and it matches where the record lives (localStorage
 * is per-origin too). A record made on one host never applies to another,
 * so there is nothing to keep in sync across hosts.
 *
 * ── Storage ──────────────────────────────────────────────────────────────
 * Per wallet address: the credential id and the sealed passcode. Never the
 * passcode in plaintext, never sent anywhere.
 */

const CRED_KEY    = (addr: string) => `meshport_biometric_cred_${addr.toLowerCase()}`
const SECRET_KEY  = (addr: string) => `meshport_biometric_secret_${addr.toLowerCase()}`
const FAIL_KEY    = (addr: string) => `meshport_biometric_fails_${addr.toLowerCase()}`
const RP_NAME = 'MeshPort'
const PROMPT_TIMEOUT_MS = 30000
/** Consecutive unconfirmed prompts after which the prompt stops opening by itself. */
const AUTO_PROMPT_MAX_FAILS = 3

// Older records (v1: key beside the ciphertext; v2: non-extractable
// IndexedDB key usable by any script in the page) are dropped - see
// dropWeakBiometricRecord. Only the legacy IndexedDB store is still touched,
// to clear it.
const IDB_NAME = 'meshport-biometric'
const IDB_STORE = 'keys'
const PRF_INFO = new TextEncoder().encode('meshport-biometric-prf-v3')

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function idbDelete(id: string): Promise<void> {
  try {
    const db = await idb()
    await new Promise<void>(resolve => {
      const tx = db.transaction(IDB_STORE, 'readwrite'); tx.objectStore(IDB_STORE).delete(id)
      tx.oncomplete = () => resolve(); tx.onerror = () => resolve()
    })
    db.close()
  } catch { /* best-effort */ }
}

type SecretRecord = { v: 3; salt: string; iv: string; ciphertext: string } & {
  // The stored passcode HASH (public, already in localStorage) that this
  // record's passcode was confirmed to match. When it still equals the
  // current hash, a successful fingerprint unlock counts as verified at once
  // - no second 600k-round passcode check. Not a passcode verifier itself.
  forHash?: string
}

function readRecord(walletAddress: string): { credId: string; rec: SecretRecord } | null {
  try {
    const credId = localStorage.getItem(CRED_KEY(walletAddress))
    const raw = localStorage.getItem(SECRET_KEY(walletAddress))
    if (!credId || !raw) return null
    const rec = JSON.parse(raw) as Partial<SecretRecord>
    if (rec.v !== 3 || !rec.salt || !rec.iv || !rec.ciphertext) return null
    return { credId, rec: rec as SecretRecord }
  } catch {
    return null
  }
}

/**
 * Writes the credential id and sealed record together. If either write
 * fails (storage full / blocked) both are removed, so a half-written
 * registration never looks enabled.
 */
function saveRecord(walletAddress: string, credId: string, rec: SecretRecord): boolean {
  try {
    localStorage.setItem(SECRET_KEY(walletAddress), JSON.stringify(rec))
    localStorage.setItem(CRED_KEY(walletAddress), credId)
    void idbDelete(walletAddress.toLowerCase())
    return true
  } catch {
    try { localStorage.removeItem(SECRET_KEY(walletAddress)); localStorage.removeItem(CRED_KEY(walletAddress)) } catch { /* blocked */ }
    return false
  }
}

/** Remember that this record's passcode matches `storedHash`. */
function setRecordForHash(walletAddress: string, storedHash: string): void {
  try {
    const raw = localStorage.getItem(SECRET_KEY(walletAddress))
    if (!raw) return
    const rec = JSON.parse(raw) as SecretRecord
    if (rec.forHash === storedHash) return
    localStorage.setItem(SECRET_KEY(walletAddress), JSON.stringify({ ...rec, forHash: storedHash }))
  } catch { /* best-effort */ }
}

async function prfKey(prfOutput: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: PRF_INFO }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
async function seal(key: CryptoKey, passcode: string): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(passcode))
  return { iv: toB64(iv), ciphertext: toB64(new Uint8Array(ct)) }
}
async function open(key: CryptoKey, iv: string, ciphertext: string): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, key, fromB64(ciphertext))
  return new TextDecoder().decode(pt)
}

/**
 * Seals `passcode` under a PRF output and proves the round trip before
 * anything is stored: a record that can't be opened again is never written.
 */
async function sealVerified(prf: Uint8Array<ArrayBuffer>, passcode: string, salt: string): Promise<SecretRecord | null> {
  const key = await prfKey(prf)
  const sealed = await seal(key, passcode)
  if ((await open(key, sealed.iv, sealed.ciphertext)) !== passcode) return null
  return { v: 3, salt, ...sealed }
}

/**
 * Only v3 records are kept: v1 kept its AES key right beside the sealed
 * passcode, and v2's device key can be used by any script running in this
 * page - either way the passcode (which approves payments) could be read
 * without a fingerprint. Older records are removed; the person turns
 * fingerprint unlock on again (v3 where the phone supports it).
 */
export function dropWeakBiometricRecord(walletAddress: string): boolean {
  try {
    const raw = localStorage.getItem(SECRET_KEY(walletAddress))
    if (!raw) return false
    if ((JSON.parse(raw) as { v?: number }).v === 3) return false
  } catch { /* unreadable: drop it */ }
  removeBiometric(walletAddress)
  return true
}

// ─── WebAuthn plumbing ───────────────────────────────────────────────────

type PrfExtension = { enabled?: boolean; results?: { first?: BufferSource } }

function prfExtension(cred: PublicKeyCredential | null): PrfExtension | null {
  try {
    const ext = (cred as unknown as { getClientExtensionResults?: () => { prf?: PrfExtension } } | null)?.getClientExtensionResults?.()
    return ext?.prf ?? null
  } catch {
    return null
  }
}

/** The PRF output as its own byte array (it may arrive as an ArrayBuffer or a view). */
function prfOutput(ext: PrfExtension | null): Uint8Array<ArrayBuffer> | null {
  const first = ext?.results?.first
  if (!first) return null
  const view = ArrayBuffer.isView(first)
    ? new Uint8Array(first.buffer, first.byteOffset, first.byteLength)
    : new Uint8Array(first as ArrayBuffer)
  if (view.byteLength === 0) return null
  const out = new Uint8Array(view.byteLength)
  out.set(view)
  return out
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  let diff = 0
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

function toB64(bytes: Uint8Array): string { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s) }
function fromB64(str: string): Uint8Array<ArrayBuffer> { return new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0))) }
function toB64Url(bytes: Uint8Array): string { return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
function fromB64Url(str: string): Uint8Array<ArrayBuffer> { return fromB64(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4)) }

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)) }

/** One assertion for one known credential, evaluating PRF with `salt`. */
async function getAssertion(credId: string, salt: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<PublicKeyCredential | null> {
  return await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: fromB64Url(credId) }],
      userVerification: 'required',
      timeout: PROMPT_TIMEOUT_MS,
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
    signal,
  }) as PublicKeyCredential | null
}

/**
 * Tells the authenticator a credential is no longer used, so a discarded
 * registration doesn't stay behind as a stray "MeshPort" passkey. Only
 * where the browser supports it (Chrome 132+, Safari 26+); a no-op
 * elsewhere. Never throws.
 */
function discardCredential(credId: string): void {
  try {
    const signal = (globalThis.PublicKeyCredential as unknown as { signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void> } | undefined)?.signalUnknownCredential
    const rpId = typeof location !== 'undefined' ? location.hostname : ''
    if (typeof signal !== 'function' || !rpId || !credId) return
    void signal.call(globalThis.PublicKeyCredential, { rpId, credentialId: credId }).catch(() => {})
  } catch { /* best-effort */ }
}

/** A stable, non-identifying user handle per wallet: re-enabling replaces the passkey instead of adding another. */
async function userHandle(walletAddress: string): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`meshport-biometric:${walletAddress.toLowerCase()}`))
  return new Uint8Array(digest.slice(0, 16))
}

// ─── Errors ──────────────────────────────────────────────────────────────

export type BiometricFailureReason =
  | 'cancelled'      // prompt dismissed, timed out, or refused without a tap
  | 'unsupported'    // no platform authenticator, or no PRF
  | 'no-screen-lock' // the device has no fingerprint / face / screen lock set up
  | 'security'       // the page's origin can't use WebAuthn (wrong host, not https)
  | 'exists'         // the authenticator already holds this credential
  | 'storage'        // the record couldn't be saved
  | 'mismatch'       // the verification test didn't reproduce the key
  | 'error'          // anything else

export function biometricFailureMessage(reason: BiometricFailureReason, label: string): string {
  switch (reason) {
    case 'cancelled':      return `${label} wasn't confirmed, so nothing changed. You can turn it on later in Settings.`
    case 'unsupported':    return `This device or browser can't keep ${label} unlock encrypted. Keep using your passcode.`
    case 'no-screen-lock': return `Set up ${label} or a screen lock on this device first, then try again.`
    case 'security':       return `${label} can't be used on this web address. Open MeshPort from its secure (https) address and try again.`
    case 'exists':         return `This device already has a MeshPort passkey for this account. Remove it in your device's passkey settings and try again.`
    case 'storage':        return `Couldn't save ${label} on this device (browser storage is full or blocked). Keep using your passcode.`
    case 'mismatch':       return `The ${label} check didn't match, so nothing was saved. Please try again.`
    default:               return `Couldn't turn on ${label}. Your passcode still works.`
  }
}

/** Maps a WebAuthn DOMException to what actually went wrong. */
export function classifyWebAuthnError(e: unknown): BiometricFailureReason {
  const name = (e as { name?: string } | null)?.name
  switch (name) {
    case 'NotAllowedError':
    case 'AbortError':
      return 'cancelled'
    case 'NotSupportedError':
      return 'unsupported'
    case 'ConstraintError':
      return 'no-screen-lock'
    case 'SecurityError':
      return 'security'
    case 'InvalidStateError':
      return 'exists'
    case 'QuotaExceededError':
      return 'storage'
    default:
      return 'error'
  }
}

// ─── Capability ──────────────────────────────────────────────────────────

async function checkPlatformAuthenticator(): Promise<boolean> {
  try {
    return await (PublicKeyCredential as unknown as { isUserVerifyingPlatformAuthenticatorAvailable: () => Promise<boolean> }).isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

/**
 * Whether the browser says it supports PRF. `undefined` when it can't say
 * (no getClientCapabilities - older Chrome/Safari that may still support
 * PRF): registration then finds out for real and fails safely.
 */
async function checkPrfCapability(): Promise<boolean | undefined> {
  try {
    const get = (PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> }).getClientCapabilities
    if (typeof get !== 'function') return undefined
    const caps = await get.call(PublicKeyCredential)
    const prf = caps?.['extension:prf']
    return typeof prf === 'boolean' ? prf : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether this device/browser can do biometric unlock at all: a
 * user-verifying platform authenticator, and PRF (unless the browser can't
 * tell - see checkPrfCapability).
 *
 * Retries once on a `false` platform result: some iOS Safari versions
 * spuriously report unsupported on the very first call right after a fresh
 * page mount, then correctly return true moments later.
 */
export async function isBiometricSupported(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.PublicKeyCredential) return false
  if ((await checkPrfCapability()) === false) return false
  if (await checkPlatformAuthenticator()) return true
  await sleep(350)
  return checkPlatformAuthenticator()
}

/** iPadOS reports itself as a Mac; a touch screen tells them apart. */
function isIPadOS(ua: string): boolean {
  return /Macintosh/.test(ua) && typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 1
}

/** Rough platform label for copy - "Use Face ID" reads better on iOS than "Use biometric". */
export function biometricLabel(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/iPhone|iPad|iPod/.test(ua) || isIPadOS(ua)) return 'Face ID'
  if (/Android/.test(ua)) return 'Fingerprint'
  if (/Macintosh/.test(ua)) return 'Touch ID'
  if (/Windows/.test(ua)) return 'Windows Hello'
  return 'Biometric'
}

/**
 * iPhone, iPad and Mac: a website can only reach Face ID / Touch ID through
 * Apple's passkeys - turning it on shows Apple's own "Save a passkey for
 * meshport.xyz?" sheet before Face ID, whatever options are passed. There
 * is no web API for the plain lock-screen prompt; only a native app gets
 * that. The app explains
 * the sheet up front so it doesn't look like something went wrong.
 * Android (screen lock) and Windows (Windows Hello) show their normal
 * device prompt.
 */
export function isApplePasskeyDevice(): boolean {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  return /iPhone|iPad|iPod|Macintosh/.test(ua)
}

/** A complete, current (v3) record exists for this wallet on this device. */
export function hasBiometricRegistered(walletAddress: string): boolean {
  return !!readRecord(walletAddress)
}

// ─── Skip-offer cooldown ───────────────────────────────────────────────────
// The unlock-screen biometric offer (PasscodeLockPage's handleUnlock, when
// there's no credential registered yet) shouldn't nag on every single fresh
// login - if the user already said "skip" once, wait 24h from that moment
// before offering again. Per wallet address, same as everything else here.
const SKIP_KEY = (addr: string) => `meshport_biometric_offer_skip_${addr.toLowerCase()}`
const SKIP_COOLDOWN_MS = 24 * 60 * 60 * 1000 // 24 hours

export function recordBiometricOfferSkip(walletAddress: string) {
  try { localStorage.setItem(SKIP_KEY(walletAddress), String(Date.now())) } catch {}
}

/**
 * Clears the skip-cooldown record for this wallet - called on a genuine
 * logout (see store/index.ts's logout()). A logout is a real fresh start:
 * the next login (or a seed phrase re-imported for this same address)
 * should get the auto-offer again on the next unlock regardless of
 * whether it was skipped before logging out.
 */
export function clearBiometricOfferSkip(walletAddress: string): void {
  try { localStorage.removeItem(SKIP_KEY(walletAddress)) } catch { /* best-effort */ }
}

/** True if the offer was skipped within the last 24h and shouldn't be shown again yet. */
export function wasBiometricOfferSkippedRecently(walletAddress: string): boolean {
  try {
    const raw = localStorage.getItem(SKIP_KEY(walletAddress))
    if (!raw) return false
    const skippedAt = Number(raw)
    if (!Number.isFinite(skippedAt)) return false
    return Date.now() - skippedAt < SKIP_COOLDOWN_MS
  } catch {
    return false
  }
}

// ─── Auto-prompt back-off ────────────────────────────────────────────────
// A prompt that keeps getting dismissed (passkey deleted in the OS, a
// sensor that won't read, or someone who simply prefers typing) must not
// stand in front of every payment. After a few unconfirmed prompts in a
// row the pad stops opening it by itself; the key stays to tap.
function recordPromptFailure(walletAddress: string): void {
  try { localStorage.setItem(FAIL_KEY(walletAddress), String(promptFailures(walletAddress) + 1)) } catch { /* best-effort */ }
}
function resetPromptFailures(walletAddress: string): void {
  try { localStorage.removeItem(FAIL_KEY(walletAddress)) } catch { /* best-effort */ }
}
function promptFailures(walletAddress: string): number {
  try { const n = Number(localStorage.getItem(FAIL_KEY(walletAddress))); return Number.isFinite(n) ? n : 0 } catch { return 0 }
}
/** Whether the biometric prompt may open by itself (it always may when tapped). */
export function shouldAutoPromptBiometric(walletAddress: string): boolean {
  return promptFailures(walletAddress) < AUTO_PROMPT_MAX_FAILS
}

// ─── Registration ────────────────────────────────────────────────────────

/** A created credential still waiting for its verification test (memory only). */
export type PendingBiometricRegistration = {
  walletAddress: string
  passcode: string
  credId: string
  salt: string
  /** PRF output create() returned, if any - the test's output must match it. */
  fromCreate: Uint8Array<ArrayBuffer> | null
  /** Re-sealing an existing credential for a new passcode (updateBiometricPasscode). */
  reseal?: boolean
}

export type BiometricRegisterResult =
  | { status: 'ok' }
  | { status: 'needs-confirm'; pending: PendingBiometricRegistration }
  | { status: 'failed'; reason: BiometricFailureReason }

const failed = (reason: BiometricFailureReason): BiometricRegisterResult => ({ status: 'failed', reason })

/**
 * Which kind of credential to ask for. A passkey (discoverable) everywhere
 * but Windows: on Android only passkeys are kept in Google Password Manager,
 * which supports PRF - a non-discoverable credential goes through Play
 * Services' older FIDO path, which has no PRF, so registration always ended
 * "unsupported" on Android phones with a fingerprint. Apple always makes a
 * passkey anyway. Windows keeps 'discouraged': asking for a passkey there
 * made Edge / Windows try to sync it to Microsoft Password Manager and stall
 * when that service was unreachable. Unlock always names the exact
 * credential, so either kind works the same afterwards.
 */
export function residentKeyFor(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): ResidentKeyRequirement {
  return /Windows/.test(ua) ? 'discouraged' : 'required'
}

/**
 * Why a registration didn't finish, for client_errors: which step, the
 * outcome, the platform and what the browser said it supports. No keys,
 * passcode, credential id or address.
 */
function reportRegistration(stage: string, reason: BiometricFailureReason, detail = ''): void {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const platform = /Android/.test(ua) ? 'android' : /iPhone|iPad|iPod/.test(ua) || isIPadOS(ua) ? 'ios' : /Macintosh/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'windows' : 'other'
  const browser = (ua.match(/(EdgA?|SamsungBrowser|Firefox|CriOS|Chrome|Version)\/(\d+)/) ?? [])[0] ?? 'unknown'
  void checkPrfCapability().then(prf => import('@/lib/errorReport').then(r => r.reportClientError('rejection', new Error(
    `[biometric register] ${stage}: ${reason} (${platform} ${browser}, prf capability=${prf ?? 'unknown'}, residentKey=${residentKeyFor(ua)}${detail ? `, ${detail}` : ''})`,
  )))).catch(() => {})
}

/**
 * Registers a platform credential and stores the passcode sealed under its
 * PRF output - see "Registration sequence" at the top. Never throws. On
 * anything but 'ok' nothing is stored (a 'needs-confirm' credential exists
 * only in memory until confirmed or abandoned), so passcode login is
 * untouched.
 */
export async function registerBiometric(walletAddress: string, rawPasscode: string, userLabel: string): Promise<BiometricRegisterResult> {
  if (!walletAddress || !rawPasscode) return failed('error')
  if (!(await isBiometricSupported())) { reportRegistration('capability check', 'unsupported'); return failed('unsupported') }
  // Re-enabling replaces whatever this device had for the wallet.
  removeBiometric(walletAddress)

  let credId: string | null = null
  try {
    const salt = crypto.getRandomValues(new Uint8Array(32))
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: RP_NAME }, // id: the current hostname (see "Relying party" above)
        user: { id: await userHandle(walletAddress), name: userLabel, displayName: userLabel },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          // A passkey except on Windows - see residentKeyFor (Android needs it for PRF).
          residentKey: residentKeyFor(),
          requireResidentKey: residentKeyFor() === 'required',
        },
        timeout: PROMPT_TIMEOUT_MS,
        attestation: 'none', // no relying-party server - device-local model
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    }) as PublicKeyCredential | null
    if (!credential) return failed('cancelled')
    credId = toB64Url(new Uint8Array(credential.rawId))

    const ext = prfExtension(credential)
    // Explicitly no PRF on this authenticator - never store a weaker copy.
    if (ext?.enabled === false) { discardCredential(credId); reportRegistration('create', 'unsupported', 'prf.enabled=false'); return failed('unsupported') }

    const pending: PendingBiometricRegistration = { walletAddress, passcode: rawPasscode, credId, salt: toB64(salt), fromCreate: prfOutput(ext) }
    credId = null // finishRegistration owns it from here
    return await finishRegistration(pending, true)
  } catch (e) {
    if (credId) discardCredential(credId)
    const reason = classifyWebAuthnError(e)
    console.warn('[biometric] registration failed:', reason, e instanceof Error ? `${e.name}: ${e.message}` : e)
    if (reason !== 'cancelled') reportRegistration('create', reason, e instanceof Error ? e.name : 'unknown error')
    return failed(reason)
  }
}

/** The verification test for a 'needs-confirm' registration - call from a tap. */
export function confirmBiometricRegistration(pending: PendingBiometricRegistration): Promise<BiometricRegisterResult> {
  return finishRegistration(pending, false)
}

/** Skip after 'needs-confirm': forgets the unconfirmed credential. */
export function abandonBiometricRegistration(pending: PendingBiometricRegistration): void {
  discardCredential(pending.credId)
}

async function finishRegistration(p: PendingBiometricRegistration, firstAttempt: boolean): Promise<BiometricRegisterResult> {
  let assertion: PublicKeyCredential | null
  try {
    assertion = await getAssertion(p.credId, fromB64(p.salt))
  } catch (e) {
    const reason = classifyWebAuthnError(e)
    // The second prompt can be refused for want of a fresh tap (Safari):
    // keep the credential and ask for one.
    if (reason === 'cancelled' && firstAttempt) return { status: 'needs-confirm', pending: p }
    discardCredential(p.credId)
    console.warn('[biometric] verification test failed:', reason, e instanceof Error ? `${e.name}: ${e.message}` : e)
    if (reason !== 'cancelled') reportRegistration('verify', reason, e instanceof Error ? e.name : 'unknown error')
    return failed(reason)
  }
  try {
    if (!assertion) { discardCredential(p.credId); return failed('cancelled') }
    if (toB64Url(new Uint8Array(assertion.rawId)) !== p.credId) { discardCredential(p.credId); return failed('mismatch') }
    const prf = prfOutput(prfExtension(assertion))
    if (!prf) { discardCredential(p.credId); reportRegistration('verify', 'unsupported', 'no prf result on assertion'); return failed('unsupported') }
    if (p.fromCreate && !sameBytes(p.fromCreate, prf)) { discardCredential(p.credId); reportRegistration('verify', 'mismatch', 'create and get prf differ'); return failed('mismatch') }
    const rec = await sealVerified(prf, p.passcode, p.salt)
    if (!rec) { discardCredential(p.credId); return failed('mismatch') }
    if (!saveRecord(p.walletAddress, p.credId, rec)) { discardCredential(p.credId); return failed('storage') }
    resetPromptFailures(p.walletAddress)
    requestPersistentStorage()
    return { status: 'ok' }
  } catch (e) {
    discardCredential(p.credId)
    console.warn('[biometric] sealing failed:', e instanceof Error ? `${e.name}: ${e.message}` : e)
    return failed('error')
  }
}

/**
 * Asks the browser not to evict this site's storage (the record lives in
 * localStorage). Best-effort: browsers may decline, and Safari's 7-day rule
 * for sites not added to the Home Screen still applies - the setting then
 * turns itself off (AppLayout) and the passcode is used.
 */
function requestPersistentStorage(): void {
  try {
    const storage = (globalThis.navigator as Navigator | undefined)?.storage
    if (typeof storage?.persist !== 'function') return
    void storage.persisted().then(already => (already ? true : storage.persist())).catch(() => {})
  } catch { /* best-effort */ }
}

// ─── Unlock ──────────────────────────────────────────────────────────────

export type BiometricUnlockResult =
  | { ok: true; passcode: string; reason?: undefined }
  | { ok: false; passcode?: undefined; reason: 'not-registered' | 'cancelled' | 'invalidated' | 'error' }

/**
 * A record that can no longer produce the passcode (no PRF on this
 * assertion, or it no longer decrypts) is removed and the setting turned
 * off, so later payments go straight to the passcode instead of opening a
 * prompt that can't work.
 */
function invalidate(walletAddress: string, why: string): void {
  console.warn('[biometric] record invalidated:', why)
  removeBiometric(walletAddress)
  import('@/store').then(({ useAuthStore, useUIStore }) => {
    if (!useAuthStore.getState().biometricEnabled) return
    useAuthStore.getState().setBiometricEnabled(false)
    useUIStore.getState().showToastMessage(`${biometricLabel()} unlock stopped working on this device and was turned off - use your passcode`, 'info')
  }).catch(() => {})
}

/**
 * Opens the OS prompt and, only on a verified success, recovers the
 * passcode. Never throws. `signal` lets the caller close the prompt (the
 * person chose "Use passcode"). `storedHash` lets a successful scan count as
 * already verified - see SecretRecord.forHash.
 */
export async function unlockWithBiometric(walletAddress: string, storedHash?: string, signal?: AbortSignal): Promise<BiometricUnlockResult> {
  if (!walletAddress) return { ok: false, reason: 'not-registered' }
  if (dropWeakBiometricRecord(walletAddress)) { invalidate(walletAddress, 'legacy record'); return { ok: false, reason: 'invalidated' } }
  const stored = readRecord(walletAddress)
  if (!stored) return { ok: false, reason: 'not-registered' }
  const { credId, rec } = stored

  let assertion: PublicKeyCredential | null
  try {
    assertion = await getAssertion(credId, fromB64(rec.salt), signal)
  } catch (e) {
    const reason = classifyWebAuthnError(e)
    if (!signal?.aborted) recordPromptFailure(walletAddress)
    console.warn('[biometric] unlock prompt failed:', reason, e instanceof Error ? `${e.name}: ${e.message}` : e)
    return { ok: false, reason: reason === 'cancelled' ? 'cancelled' : 'error' }
  }
  if (signal?.aborted) return { ok: false, reason: 'cancelled' }
  if (!assertion) { recordPromptFailure(walletAddress); return { ok: false, reason: 'cancelled' } }

  const prf = prfOutput(prfExtension(assertion))
  if (!prf) { invalidate(walletAddress, 'no PRF output'); return { ok: false, reason: 'invalidated' } }
  let passcode: string
  try {
    passcode = await open(await prfKey(prf), rec.iv, rec.ciphertext)
  } catch {
    invalidate(walletAddress, 'does not decrypt')
    return { ok: false, reason: 'invalidated' }
  }
  resetPromptFailures(walletAddress)

  if (storedHash) {
    if (rec.forHash === storedHash) {
      // Confirmed against this exact hash before → verified now, instantly.
      await markPasscodeVerified(passcode, storedHash).catch(() => {})
    } else {
      // Not confirmed yet (older record, or the passcode changed): the
      // caller does the full check. Once that passes, remember it so the
      // next scan is instant.
      setTimeout(() => {
        isPasscodeVerifiedThisSession(passcode, storedHash)
          .then(ok => { if (ok) setRecordForHash(walletAddress, storedHash) })
          .catch(() => {})
      }, 4000)
    }
  }
  return { ok: true, passcode }
}

/** unlockWithBiometric for callers that only need the passcode or null. */
export async function verifyBiometricAndGetPasscode(walletAddress: string, storedHash?: string, signal?: AbortSignal): Promise<string | null> {
  const r = await unlockWithBiometric(walletAddress, storedHash, signal)
  return r.ok ? r.passcode : null
}

/**
 * Re-seals the biometric copy after a passcode change: one scan of the SAME
 * credential with a fresh salt, round-trip checked, then written together.
 * No new enrollment. The old record (old passcode) is removed first,
 * whatever happens next.
 *  - 'ok': on for the new passcode.
 *  - 'needs-confirm': the prompt was cancelled or refused for want of a
 *    fresh tap (Safari, after the passcode hashing). The credential is kept;
 *    finish with confirmBiometricRegistration from a tap (the Enable screen),
 *    or abandonBiometricRegistration. Off until then.
 *  - 'failed': off (no PRF, storage, nothing registered...).
 */
export async function updateBiometricPasscode(walletAddress: string, newPasscode: string): Promise<BiometricRegisterResult> {
  const stored = readRecord(walletAddress)
  if (!stored) { removeBiometric(walletAddress); return failed('error') }
  clearLocalRecord(walletAddress)
  const pending: PendingBiometricRegistration = {
    walletAddress, passcode: newPasscode, credId: stored.credId,
    salt: toB64(crypto.getRandomValues(new Uint8Array(32))), fromCreate: null, reseal: true,
  }
  return finishRegistration(pending, true)
}

function clearLocalRecord(walletAddress: string): void {
  try {
    localStorage.removeItem(CRED_KEY(walletAddress))
    localStorage.removeItem(SECRET_KEY(walletAddress))
    localStorage.removeItem(FAIL_KEY(walletAddress))
  } catch { /* best-effort */ }
}

/**
 * Settings → off, logout, a failed passcode re-seal, or an invalid record:
 * removes this wallet's record and tells the authenticator the passkey is
 * no longer used (where supported).
 */
export function removeBiometric(walletAddress: string): void {
  let credId: string | null = null
  try { credId = localStorage.getItem(CRED_KEY(walletAddress)) } catch { /* blocked */ }
  clearLocalRecord(walletAddress)
  if (credId) discardCredential(credId)
  void idbDelete(walletAddress.toLowerCase())
}
