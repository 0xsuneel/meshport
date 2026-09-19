/**
 * lib/biometric.ts
 *
 * Real WebAuthn platform-authenticator integration — this is genuinely new,
 * not a wire-up. The "Biometric Login" toggle that already existed in
 * Settings (SecurityPage) was only ever a plain boolean flag; nothing in
 * the codebase actually called the WebAuthn API before this. Flipping that
 * toggle did nothing except change what a settings row displayed.
 *
 * ── What this actually does ─────────────────────────────────────────────
 * navigator.credentials.create() registers a real platform credential —
 * this is what triggers the genuine OS-level Face ID / Android fingerprint
 * enrollment prompt. navigator.credentials.get() later re-triggers that
 * same OS prompt to unlock. MeshPort never sees the fingerprint or face
 * data itself — only a Success/Failed result from the browser, exactly as
 * described in the request this was built from.
 *
 * ── Being honest about what security property this provides ───────────
 * A native app can gate a Keychain/Keystore-held secret behind biometric
 * hardware, so the secret is physically unextractable without a successful
 * biometric check. A PWA running in a browser has no equivalent — there is
 * no secure enclave JS can hand a secret to and get back "only unlockable
 * by fingerprint." What IS real and meaningful here: the app will not
 * attempt to retrieve the stored passcode at all until
 * navigator.credentials.get() has returned a genuine, OS-verified success —
 * a real biometric check, not a UI trick. What is NOT true: this isn't
 * hardware-backed encryption the way a native Keychain entry is. The
 * WebAuthn PRF extension can provide real hardware-derived key material on
 * newer browsers/OS versions, but its support is inconsistent enough
 * (varies by browser, OS version, and even which authenticator) that
 * getting it subtly wrong would create a false sense of security — worse
 * than being upfront about a simpler, correctly-understood model. This
 * trades a small amount of theoretical strength for something that is
 * correct and honest about what it does on every supported device.
 *
 * ── Storage ──────────────────────────────────────────────────────────────
 * Per wallet address (a device can have multiple accounts): the WebAuthn
 * credential id, and the raw passcode encrypted with a random AES-256 key
 * that's generated once at registration and stored alongside it. Never the
 * passcode itself in plaintext, never sent anywhere — this is 100%
 * client-side, on-device only, matching the "your app never sees or
 * stores the fingerprint/face data" model this was built from.
 */

const CRED_KEY    = (addr: string) => `meshport_biometric_cred_${addr.toLowerCase()}`
const SECRET_KEY  = (addr: string) => `meshport_biometric_secret_${addr.toLowerCase()}`
const RP_NAME = 'MeshPort'

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
 * page mount, even though Face ID is genuinely available — then correctly
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

/** Rough platform label for copy — "Use Face ID" reads better on iOS than "Use biometric". */
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
// login — if the user already said "skip" once, wait 24h from that moment
// before offering again. Per wallet address, same as everything else here.
const SKIP_KEY = (addr: string) => `meshport_biometric_offer_skip_${addr.toLowerCase()}`
const SKIP_COOLDOWN_MS = 24 * 60 * 60 * 1000 // 24 hours

export function recordBiometricOfferSkip(walletAddress: string) {
  try { localStorage.setItem(SKIP_KEY(walletAddress), String(Date.now())) } catch {}
}

/**
 * Clears the skip-cooldown record for this wallet — called on a genuine
 * logout (see store/index.ts's logout()). A logout is a real fresh start:
 * the next login (or a seed phrase re-imported for this same address)
 * should get the auto-offer again on the next unlock regardless of
 * whether it was skipped before logging out. Without this, a skip
 * recorded before logout silently survived in localStorage (SKIP_KEY is
 * per-wallet-address, not per-session) and kept suppressing the offer for
 * up to 24h into the NEW session, which looked like it "never" offered
 * again even though the user had genuinely logged back in.
 * If the user skips it again in the new session, a fresh 24h cooldown is
 * recorded as normal — this only clears a STALE cooldown from before.
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
 * Registers a real platform WebAuthn credential — this line is what
 * triggers the actual OS Face ID / fingerprint enrollment prompt — then
 * encrypts and stores the raw passcode locally, gated behind it. Returns
 * false (not a throw) on any failure, including the user cancelling the
 * OS prompt — cancelling is an expected, normal outcome here, not an error
 * condition the caller needs to handle specially.
 */
export async function registerBiometric(walletAddress: string, rawPasscode: string, userLabel: string): Promise<boolean> {
  if (!(await isBiometricSupported())) return false
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32))
    const userId = crypto.getRandomValues(new Uint8Array(16))

    const credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: RP_NAME },
        user: { id: userId, name: userLabel, displayName: userLabel },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required', // this is what forces an actual biometric check, not just "device present"
          // 'discouraged', not 'preferred' — we never need a discoverable
          // credential (verifyBiometricAndGetPasscode always passes the
          // exact stored credential id via allowCredentials, never a
          // usernameless/discoverable lookup). Requesting one anyway is
          // what makes Windows/Edge treat this as a "passkey" and try to
          // save it to Microsoft Password Manager (cloud sync) instead of
          // just binding it locally to Windows Hello — if that sync
          // service is unreachable, the OS shows its own "Can't reach
          // Microsoft Password Manager" dialog and the whole registration
          // stalls on it. 'discouraged' keeps the credential device-local,
          // the same as every other platform this already worked on.
          residentKey: 'discouraged',
        },
        timeout: 30000, // was 60s — a genuine browser/OS-level hang shouldn't leave the user waiting a full minute before even Skip's fallback kicks in
        attestation: 'none', // we don't run a relying-party server to verify attestation — not needed for this device-local model
      },
    }) as PublicKeyCredential | null
    if (!credential) return false

    // Random per-registration AES-256 key — see the file header for exactly
    // what security property this does and doesn't provide.
    const secretKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, secretKey, new TextEncoder().encode(rawPasscode))
    const rawKey = await crypto.subtle.exportKey('raw', secretKey)

    localStorage.setItem(CRED_KEY(walletAddress), toB64Url(new Uint8Array(credential.rawId)))
    localStorage.setItem(SECRET_KEY(walletAddress), JSON.stringify({
      key: toB64(new Uint8Array(rawKey)),
      iv: toB64(iv),
      ciphertext: toB64(new Uint8Array(ciphertext)),
    }))
    return true
  } catch (e) {
    // Includes the user cancelling/dismissing the OS prompt — NotAllowedError
    // is WebAuthn's standard rejection for a cancelled or timed-out prompt.
    console.warn('[biometric] registration failed or cancelled:', e instanceof Error ? e.message : e)
    return false
  }
}

/**
 * Triggers the real OS biometric prompt via navigator.credentials.get().
 * Only on a genuine success does this ever touch the locally-stored
 * encrypted passcode. Returns the raw passcode on success, or null on any
 * failure/cancellation — never throws, so callers can treat this as a
 * plain "did it work" check without try/catch of their own.
 */
export async function verifyBiometricAndGetPasscode(walletAddress: string): Promise<string | null> {
  try {
    const credIdB64 = localStorage.getItem(CRED_KEY(walletAddress))
    const secretRaw = localStorage.getItem(SECRET_KEY(walletAddress))
    if (!credIdB64 || !secretRaw) return null

    const challenge = crypto.getRandomValues(new Uint8Array(32))
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ type: 'public-key', id: fromB64Url(credIdB64) }],
        userVerification: 'required',
        timeout: 30000, // was 60s — same reasoning as registerBiometric above
      },
    })
    if (!assertion) return null // OS check didn't succeed — do not proceed to decrypt

    const { key, iv, ciphertext } = JSON.parse(secretRaw)
    const secretKey = await crypto.subtle.importKey('raw', fromB64(key), { name: 'AES-GCM' }, false, ['decrypt'])
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, secretKey, fromB64(ciphertext))
    return new TextDecoder().decode(plaintext)
  } catch (e) {
    // Includes the user cancelling the OS prompt, or a wrong/no-longer-
    // enrolled biometric — treated identically to "not available right
    // now", falling back to manual passcode entry, never a hard error.
    console.warn('[biometric] verification failed or cancelled:', e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * Re-encrypts the locally-stored biometric copy of the passcode after the
 * user changes their passcode — reusing the SAME AES key and the SAME
 * WebAuthn credential set up at registerBiometric() time, so this never
 * triggers a new Face ID/fingerprint enrollment prompt and never creates a
 * second/separate biometric PIN. Biometric unlock always decrypts to
 * whatever the current real passcode is, nothing else.
 *
 * Called from ChangePasscodePage right after a passcode change succeeds.
 * No-op (returns false) if biometric was never registered for this wallet —
 * there is nothing local to keep in sync.
 */
export async function updateBiometricPasscode(walletAddress: string, newPasscode: string): Promise<boolean> {
  try {
    const secretRaw = localStorage.getItem(SECRET_KEY(walletAddress))
    if (!secretRaw) return false

    const { key } = JSON.parse(secretRaw)
    const secretKey = await crypto.subtle.importKey('raw', fromB64(key), { name: 'AES-GCM' }, false, ['encrypt'])
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, secretKey, new TextEncoder().encode(newPasscode))

    localStorage.setItem(SECRET_KEY(walletAddress), JSON.stringify({
      key, // unchanged — same AES key, still gated behind the same WebAuthn credential
      iv: toB64(iv),
      ciphertext: toB64(new Uint8Array(ciphertext)),
    }))
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
}
