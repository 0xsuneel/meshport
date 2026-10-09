import { markPasscodeVerified, isPasscodeVerifiedThisSession } from './security'
/**
 * lib/biometric.ts
 *
 * Real WebAuthn platform-authenticator integration - this is genuinely new,
 * not a wire-up. The "Biometric Login" toggle that already existed in
 * Settings (SecurityPage) was only ever a plain boolean flag; nothing in
 * the codebase actually called the WebAuthn API before this. Flipping that
 * toggle did nothing except change what a settings row displayed.
 *
 * ── What this actually does ─────────────────────────────────────────────
 * navigator.credentials.create() registers a real platform credential -
 * this is what triggers the genuine OS-level Face ID / Android fingerprint
 * enrollment prompt. navigator.credentials.get() later re-triggers that
 * same OS prompt to unlock. MeshPort never sees the fingerprint or face
 * data itself - only a Success/Failed result from the browser, exactly as
 * described in the request this was built from.
 *
 * ── Being honest about what security property this provides ───────────
 * A native app can gate a Keychain/Keystore-held secret behind biometric
 * hardware, so the secret is physically unextractable without a successful
 * biometric check. A PWA running in a browser has no equivalent - there is
 * no secure enclave JS can hand a secret to and get back "only unlockable
 * by fingerprint." What IS real and meaningful here: the app will not
 * attempt to retrieve the stored passcode at all until
 * navigator.credentials.get() has returned a genuine, OS-verified success -
 * a real biometric check, not a UI trick. What is NOT true: this isn't
 * hardware-backed encryption the way a native Keychain entry is. The
 * WebAuthn PRF extension can provide real hardware-derived key material on
 * newer browsers/OS versions, but its support is inconsistent enough
 * (varies by browser, OS version, and even which authenticator) that
 * getting it subtly wrong would create a false sense of security - worse
 * than being upfront about a simpler, correctly-understood model. This
 * trades a small amount of theoretical strength for something that is
 * correct and honest about what it does on every supported device.
 *
 * ── Storage ──────────────────────────────────────────────────────────────
 * Per wallet address (a device can have multiple accounts): the WebAuthn
 * credential id, and the passcode encrypted with a key that is either
 * produced by the fingerprint hardware (PRF) or held as a non-extractable
 * key in IndexedDB - see "How the stored passcode is protected" below.
 * Never the passcode in plaintext, never sent anywhere - 100% on-device.
 */

const CRED_KEY    = (addr: string) => `meshport_biometric_cred_${addr.toLowerCase()}`
const SECRET_KEY  = (addr: string) => `meshport_biometric_secret_${addr.toLowerCase()}`
const RP_NAME = 'MeshPort'

// ── How the stored passcode is protected (SECRET_KEY record, by version) ───
//  v3 - the unlock key comes from the fingerprint hardware itself (WebAuthn
//       "PRF"): the authenticator only produces it after a successful
//       biometric check, and it is never stored anywhere. Reading this
//       browser's storage gets an attacker nothing usable.
//  v2 - fallback where PRF isn't available: the unlock key is a
//       NON-EXTRACTABLE Web Crypto key kept in IndexedDB. Its bytes can't be
//       read out or copied by any script; it can only be used by this app.
//  v1 - legacy (before this fix): the raw key sat in localStorage right next
//       to the ciphertext, so anything able to read localStorage could read
//       the passcode. Upgraded automatically on the next fingerprint unlock
//       (or passcode change) - see verifyBiometricAndGetPasscode.
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
async function idbPut(id: string, key: CryptoKey): Promise<void> {
  const db = await idb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite'); tx.objectStore(IDB_STORE).put(key, id)
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
  })
  db.close()
}
async function idbGet(id: string): Promise<CryptoKey | null> {
  const db = await idb()
  const out = await new Promise<CryptoKey | null>((resolve, reject) => {
    const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(id)
    req.onsuccess = () => resolve((req.result as CryptoKey) ?? null); req.onerror = () => reject(req.error)
  })
  db.close()
  return out
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

type SecretRecord = (
  | { v?: undefined; key: string; iv: string; ciphertext: string }          // v1 legacy
  | { v: 2; iv: string; ciphertext: string; salt?: string }                 // v2 (salt kept for a later PRF upgrade)
  | { v: 3; salt: string; iv: string; ciphertext: string }                  // v3
) & {
  // The stored passcode HASH (public, already in localStorage) that this
  // record's passcode was confirmed to match. When it still equals the
  // current hash, a successful fingerprint unlock counts as verified at once
  // - no second 600k-round passcode check. Not a passcode verifier itself.
  forHash?: string
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

async function prfKey(prfOutput: BufferSource): Promise<CryptoKey> {
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
/** v2: fresh non-extractable key in IndexedDB, passcode sealed with it. */
async function writeV2(walletAddress: string, passcode: string, salt?: string): Promise<void> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  await idbPut(walletAddress.toLowerCase(), key)
  const rec: SecretRecord = { v: 2, ...(await seal(key, passcode)), ...(salt ? { salt } : {}) }
  localStorage.setItem(SECRET_KEY(walletAddress), JSON.stringify(rec))
}
/** v3: sealed with the fingerprint-derived key; nothing key-like stored. */
async function writeV3(walletAddress: string, passcode: string, salt: string, prfOutput: BufferSource): Promise<void> {
  const rec: SecretRecord = { v: 3, salt, ...(await seal(await prfKey(prfOutput), passcode)) }
  localStorage.setItem(SECRET_KEY(walletAddress), JSON.stringify(rec))
  await idbDelete(walletAddress.toLowerCase())
}
const prfFirst = (cred: PublicKeyCredential | null): ArrayBuffer | null => {
  try { return ((cred as any)?.getClientExtensionResults?.()?.prf?.results?.first as ArrayBuffer) ?? null } catch { return null }
}

function toB64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)) }
function fromB64(str: string): Uint8Array<ArrayBuffer> { return new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0))) }
function toB64Url(bytes: Uint8Array): string { return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
function fromB64Url(str: string): Uint8Array<ArrayBuffer> { return fromB64(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4)) }

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)) }

async function checkPlatformAuthenticator(): Promise<boolean> {
  try {
    return await (PublicKeyCredential as any).isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

/**
 * Whether this device/browser can do a real platform biometric check at all.
 *
 * Retries once on a `false` result: some iOS Safari versions have a
 * confirmed timing quirk where isUserVerifyingPlatformAuthenticatorAvailable()
 * spuriously reports unsupported on the very first call right after a fresh
 * page mount, even though Face ID is genuinely available - then correctly
 * returns true moments later. Without this, that false negative silently
 * skipped the biometric enrollment offer during wallet creation
 * (EnableBiometricPage auto-navigates away when this resolves false) with
 * no error or indication anything was wrong. A single retry after a short
 * delay costs nothing on devices that are genuinely unsupported (still
 * false the second time) and fixes the false-negative case.
 */
export async function isBiometricSupported(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.PublicKeyCredential) return false
  if (await checkPlatformAuthenticator()) return true
  await sleep(350)
  return checkPlatformAuthenticator()
}

/** Rough platform label for copy - "Use Face ID" reads better on iOS than "Use biometric". */
export function biometricLabel(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/iPhone|iPad|iPod/.test(ua)) return 'Face ID'
  if (/Android/.test(ua)) return 'Fingerprint'
  return 'Biometric'
}

export function hasBiometricRegistered(walletAddress: string): boolean {
  try {
    return !!localStorage.getItem(CRED_KEY(walletAddress)) && !!localStorage.getItem(SECRET_KEY(walletAddress))
  } catch {
    return false
  }
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
 * whether it was skipped before logging out. Without this, a skip
 * recorded before logout silently survived in localStorage (SKIP_KEY is
 * per-wallet-address, not per-session) and kept suppressing the offer for
 * up to 24h into the NEW session, which looked like it "never" offered
 * again even though the user had genuinely logged back in.
 * If the user skips it again in the new session, a fresh 24h cooldown is
 * recorded as normal - this only clears a STALE cooldown from before.
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

/**
 * Registers a real platform WebAuthn credential - this line is what
 * triggers the actual OS Face ID / fingerprint enrollment prompt - then
 * encrypts and stores the raw passcode locally, gated behind it. Returns
 * false (not a throw) on any failure, including the user cancelling the
 * OS prompt - cancelling is an expected, normal outcome here, not an error
 * condition the caller needs to handle specially.
 */
export async function registerBiometric(walletAddress: string, rawPasscode: string, userLabel: string): Promise<boolean> {
  if (!(await isBiometricSupported())) return false
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32))
    const userId = crypto.getRandomValues(new Uint8Array(16))
    const prfSalt = crypto.getRandomValues(new Uint8Array(32))

    const credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: RP_NAME },
        user: { id: userId, name: userLabel, displayName: userLabel },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required', // this is what forces an actual biometric check, not just "device present"
          // 'discouraged', not 'preferred' - we never need a discoverable
          // credential (verifyBiometricAndGetPasscode always passes the
          // exact stored credential id via allowCredentials, never a
          // usernameless/discoverable lookup). Requesting one anyway is
          // what makes Windows/Edge treat this as a "passkey" and try to
          // save it to Microsoft Password Manager (cloud sync) instead of
          // just binding it locally to Windows Hello - if that sync
          // service is unreachable, the OS shows its own "Can't reach
          // Microsoft Password Manager" dialog and the whole registration
          // stalls on it. 'discouraged' keeps the credential device-local,
          // the same as every other platform this already worked on.
          residentKey: 'discouraged',
        },
        timeout: 30000, // was 60s - a genuine browser/OS-level hang shouldn't leave the user waiting a full minute before even Skip's fallback kicks in
        attestation: 'none', // we don't run a relying-party server to verify attestation - not needed for this device-local model
        // Ask the fingerprint hardware for a secret (PRF) - see the storage
        // notes at the top. Browsers without it simply ignore this.
        extensions: { prf: { eval: { first: prfSalt } } } as any,
      },
    }) as PublicKeyCredential | null
    if (!credential) return false

    localStorage.setItem(CRED_KEY(walletAddress), toB64Url(new Uint8Array(credential.rawId)))
    const prf = prfFirst(credential)
    if (prf) await writeV3(walletAddress, rawPasscode, toB64(prfSalt), prf)
    else await writeV2(walletAddress, rawPasscode, toB64(prfSalt)) // upgraded to v3 on the first unlock if the device can
    return true
  } catch (e) {
    // Includes the user cancelling/dismissing the OS prompt - NotAllowedError
    // is WebAuthn's standard rejection for a cancelled or timed-out prompt.
    console.warn('[biometric] registration failed or cancelled:', e instanceof Error ? e.message : e)
    return false
  }
}

/**
 * Triggers the real OS biometric prompt via navigator.credentials.get().
 * Only on a genuine success does this ever touch the locally-stored
 * encrypted passcode. Returns the raw passcode on success, or null on any
 * failure/cancellation - never throws, so callers can treat this as a
 * plain "did it work" check without try/catch of their own.
 */
/**
 * `storedHash` (the current passcode hash) lets a successful scan count as
 * already verified: see SecretRecord.forHash. Without it, callers verify the
 * returned passcode the normal way.
 */
export async function verifyBiometricAndGetPasscode(walletAddress: string, storedHash?: string): Promise<string | null> {
  try {
    const credIdB64 = localStorage.getItem(CRED_KEY(walletAddress))
    const secretRaw = localStorage.getItem(SECRET_KEY(walletAddress))
    if (!credIdB64 || !secretRaw) return null
    const rec = JSON.parse(secretRaw) as SecretRecord
    // Salt for the fingerprint-derived key: the record's own, or a new one
    // for an older record we'd like to upgrade.
    const saltB64 = ('salt' in rec && rec.salt) ? rec.salt : toB64(crypto.getRandomValues(new Uint8Array(32)))

    const challenge = crypto.getRandomValues(new Uint8Array(32))
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ type: 'public-key', id: fromB64Url(credIdB64) }],
        userVerification: 'required',
        timeout: 30000, // was 60s - same reasoning as registerBiometric above
        extensions: { prf: { eval: { first: fromB64(saltB64) } } } as any,
      },
    }) as PublicKeyCredential | null
    if (!assertion) return null // OS check didn't succeed - do not proceed to decrypt
    const prf = prfFirst(assertion)

    let passcode: string
    if (rec.v === 3) {
      if (!prf) return null // this device no longer gives the fingerprint secret - use the passcode
      passcode = await open(await prfKey(prf), rec.iv, rec.ciphertext)
    } else if (rec.v === 2) {
      const key = await idbGet(walletAddress.toLowerCase())
      if (!key) return null
      passcode = await open(key, rec.iv, rec.ciphertext)
    } else {
      const old = rec as { key: string; iv: string; ciphertext: string }
      const legacy = await crypto.subtle.importKey('raw', fromB64(old.key), { name: 'AES-GCM' }, false, ['decrypt'])
      passcode = await open(legacy, old.iv, old.ciphertext)
    }

    // Upgrade older records now that we hold the passcode: to v3 when the
    // fingerprint gave us its secret, otherwise v1 → v2.
    try {
      if (prf && rec.v !== 3) await writeV3(walletAddress, passcode, saltB64, prf)
      else if (!rec.v) await writeV2(walletAddress, passcode, saltB64)
    } catch (e) { console.warn('[biometric] upgrade skipped:', e instanceof Error ? e.message : e) }
    if (storedHash) {
      if (rec.forHash === storedHash) {
        // Confirmed against this exact hash before → verified now, instantly.
        await markPasscodeVerified(passcode, storedHash)
        setRecordForHash(walletAddress, storedHash) // the upgrade above may have rewritten the record
      } else {
        // Not confirmed yet (older record, or the passcode changed): the
        // caller does the full check. Once that passes, remember it so the
        // next scan is instant.
        const pc = passcode
        setTimeout(() => {
          isPasscodeVerifiedThisSession(pc, storedHash)
            .then(ok => { if (ok) setRecordForHash(walletAddress, storedHash) })
            .catch(() => {})
        }, 4000)
      }
    }
    return passcode
  } catch (e) {
    // Includes the user cancelling the OS prompt, or a wrong/no-longer-
    // enrolled biometric - treated identically to "not available right
    // now", falling back to manual passcode entry, never a hard error.
    console.warn('[biometric] verification failed or cancelled:', e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * Re-encrypts the locally-stored biometric copy of the passcode after the
 * user changes their passcode - reusing the SAME AES key and the SAME
 * WebAuthn credential set up at registerBiometric() time, so this never
 * triggers a new Face ID/fingerprint enrollment prompt and never creates a
 * second/separate biometric PIN. Biometric unlock always decrypts to
 * whatever the current real passcode is, nothing else.
 *
 * Called from ChangePasscodePage right after a passcode change succeeds.
 * No-op (returns false) if biometric was never registered for this wallet -
 * there is nothing local to keep in sync.
 */
export async function updateBiometricPasscode(walletAddress: string, newPasscode: string): Promise<boolean> {
  try {
    const secretRaw = localStorage.getItem(SECRET_KEY(walletAddress))
    if (!secretRaw) return false
    const rec = JSON.parse(secretRaw) as SecretRecord
    // No fingerprint prompt here: v1/v2/v3 all re-seal as v2 with a fresh
    // non-extractable key (v3 needs the fingerprint to re-derive its key);
    // the next fingerprint unlock upgrades it back to v3 automatically.
    await writeV2(walletAddress, newPasscode, 'salt' in rec ? rec.salt : undefined)
    return true
  } catch (e) {
    console.warn('[biometric] updateBiometricPasscode failed:', e instanceof Error ? e.message : e)
    return false
  }
}

/** Called from Settings when the user disables biometric login, or on logout. (A passcode change now calls updateBiometricPasscode instead of this, so the credential survives a passcode change.) */
export function removeBiometric(walletAddress: string): void {
  try {
    localStorage.removeItem(CRED_KEY(walletAddress))
    localStorage.removeItem(SECRET_KEY(walletAddress))
  } catch { /* best-effort */ }
  void idbDelete(walletAddress.toLowerCase())
}
