/**
 * Wallet Private Key Restoration
 *
 * Two different recovery models live here, split by walletSource:
 *
 * create / import-seed / import-privkey - NO server-side fallback, by
 * design. MeshPort never stores these wallets' private key or recovery
 * phrase on its servers, in any form. Recovery only ever works from what's
 * available on THIS device, or from a recovery phrase/private key the user
 * re-enters themselves. That's the accepted tradeoff for these accounts.
 * This module's behavior for these wallet sources is UNCHANGED.
 *
 * social-auto (Google AND Email-OTP accounts, unified) - SELF-CUSTODIAL
 * since 2026-10-04. The key is made on the device (lib/socialWallet.ts)
 * and opens with the account's passkey (lib/walletPasskey.ts) or encrypted
 * Recovery QR (lib/recoveryQr.ts); MeshPort's servers hold no copy. This
 * device keeps a copy sealed with its non-extractable device key, so a
 * reload restores without a prompt. The app passcode is still an APP LOCK
 * ONLY for these accounts - it never encrypts the wallet.
 *
 * Priority order:
 * 1. Already in memory → done
 * 2a. Derive from mnemonic, IF it happens to already be in live memory -
 *    e.g. right after this same session created/imported the wallet. The
 *    mnemonic is NEVER persisted (see security.ts's encryptMnemonic /
 *    store/index.ts's persist `migrate` - it used to be, in plain text; a
 *    genuine security bug, since fixed), so after any real reload this
 *    step is naturally a no-op and falls through to 2b.
 * 2b. create / import-seed / import-privkey: session-cached decrypted key
 *    (sessionStorage, see cacheSessionPrivateKey in lib/security.ts) -
 *    lets a plain page refresh skip the passcode prompt within the same
 *    tab session. Cleared on logout and on 'offline', so it does NOT
 *    survive a real gap.
 * 3. create / import-seed / import-privkey: decrypt from this device's
 *    local encrypted key (needs the passcode that was used to encrypt it,
 *    which may not be the CURRENT passcode if the user just set a new one
 *    on a new device - that's fine, this step is just a fast path and is
 *    allowed to fail). Never attempted for social-auto - see above.
 * 4a. social-auto: this device's sealed copy.
 * 4b. Otherwise needsSocialUnlock() is true and AppLayout sends the user to
 *    the Unlock screen (passkey / Recovery QR), which needs a tap and so
 *    never runs from here.
 *
 * If none of these work, `walletRecoveryNeeded` is set on the UI store,
 * which drives a persistent, app-wide banner (see
 * components/layout/WalletRecoveryBanner.tsx) pointing the user at
 * ImportWalletPage to re-enter their recovery phrase manually - this only
 * matters for create/import accounts in practice, since social-auto
 * accounts have no recovery phrase to fall back to; if step 4 fails for a
 * social-auto account, it means the server-side vault itself is missing
 * or the session is invalid, not something the user can self-correct.
 */
import { useAuthStore, useUIStore } from '@/store'

// ── Single-flight guard ─────────────────────────────────────────────────────
// There are 13+ call sites of restorePrivateKey() across the app, several
// firing automatically on mount. Sharing one in-flight attempt avoids
// redundant concurrent network calls when multiple components ask at once.
let inFlightRestore: Promise<boolean> | null = null

// Google / email wallet with no copy on this device and none on the server:
// it opens only with the passkey or Recovery QR (/auth/recover-wallet).
let socialUnlockNeeded = false
export function needsSocialUnlock(): boolean { return socialUnlockNeeded }

// PERF FIX (transaction-speed audit, 2026-09-17): `silent`, used by
// PaySendPage/ChatPage/SwapPage/MultichainTransferPage/MultichainClaimPage
// to kick this off CONCURRENTLY with the separate verifyPasscode() PBKDF2
// derive instead of strictly after it (they used to await verifyPasscode,
// THEN await this - two independent 100k-iteration PBKDF2 derives from the
// same just-typed passcode, run back-to-back, on every send that doesn't
// already have the key warm in memory). Only the FIRST concurrent caller's
// options matter - every other caller attaches to the same in-flight
// promise below without its own opts ever being read - so passing
// `silent: true` from the speculative early call means: if the passcode
// later turns out to be wrong, this attempt fails (as it should) WITHOUT
// flipping the app-wide walletRecoveryNeeded banner on, which would
// otherwise flash "wallet recovery needed" for what's really just a
// mistyped 6-digit PIN the user is about to retry. A genuine failure from
// a normal (non-silent) call elsewhere still sets the banner exactly as
// before.
export async function restorePrivateKey(rawPasscode?: string, opts?: { silent?: boolean }): Promise<boolean> {
  if (inFlightRestore) return inFlightRestore

  inFlightRestore = (async () => {
    const restored = await attemptRestore(rawPasscode)
    if (!opts?.silent) {
      const hasWallet = !!useAuthStore.getState().walletAddress
      useUIStore.getState().setWalletRecoveryNeeded(hasWallet && !restored)
    }
    return restored
  })()

  try {
    return await inFlightRestore
  } finally {
    inFlightRestore = null
  }
}

// ─── In-memory passcode stash (replaces sessionStorage) ──────────────────────
// Security-audit finding: the raw passcode used to be stashed in
// sessionStorage (`meshport_raw_passcode`) purely so the 13+ OTHER
// restorePrivateKey() call sites across the app (App.tsx's mount effect,
// tab-visibility-change handlers, etc. - none of which have the user's
// just-typed passcode in their own local scope) could still find it during
// the brief window right after the user enters it, in case one of them
// fires before the component that collected the passcode finishes its own
// explicit restorePrivateKey(passcode) call.
//
// That reachability never actually required real browser storage: every
// place that sets this value and every place that reads it runs within the
// same SPA session, connected only by React Router navigate() calls, which
// never reload the page or reset JS module state. sessionStorage was
// strictly more exposure than necessary - readable by devtools/extensions
// with storage access, and outliving the narrow window it's actually needed
// for. A plain in-memory variable is reachable from exactly the same call
// sites for exactly as long as it's needed, and disappears completely on
// any real page reload instead of lingering.
//
// Trade-off, stated plainly: if the user hard-refreshes the browser in the
// narrow window between entering their passcode and the wallet key actually
// restoring, this value is gone (sessionStorage would have survived that).
// The fallback in that case is not silent failure - it's exactly the
// existing, already-hardened recovery path (WalletRecoveryBanner + getKey()
// retry loops elsewhere in the app), which prompts the user to retry rather
// than leaving anything broken.
let pendingRawPasscode: string | null = null
export function stashRawPasscode(pc: string): void { pendingRawPasscode = pc }
export function getPendingRawPasscode(): string | null { return pendingRawPasscode }
export function clearRawPasscode(): void { pendingRawPasscode = null }

async function attemptRestore(rawPasscode?: string): Promise<boolean> {
  const { walletAddress, privateKey, mnemonic, walletSource, setWallet } = useAuthStore.getState()

  if (privateKey) return true
  if (!walletAddress) return false


  // ── 1. Derive from mnemonic, if it's already in live memory ────────────────
  // Only ever true within the same session that just created/imported this
  // wallet - the mnemonic is never persisted (see this file's header
  // comment), so it's `null` here after any real reload and this step is a
  // no-op, falling through to step 2 below.
  if (mnemonic) {
    try {
      const { importFromMnemonic } = await import('@/lib/arc')
      const w = await importFromMnemonic(mnemonic)
      if (w?.privateKey) {
        setWallet(walletAddress, w.privateKey, mnemonic, walletSource || 'create')
        return true
      }
    } catch {}
  }

  // ── 2. session-cached decrypted key (create / import-seed / import-privkey) ─
  // Skips the passcode prompt for a plain refresh within the same tab
  // session - see cacheSessionPrivateKey's comment in lib/security.ts.
  // Cleared on logout and on the browser's 'offline' event (App.tsx), so a
  // genuine gap (offline, then back) still falls through to step 3 below
  // and asks for the passcode again.
  //
  // Widened (was import-privkey ONLY) - SECURITY FIX: create/import-seed
  // wallets used to skip straight to step 1 above (re-deriving the key from
  // the raw mnemonic, which used to be persisted in plain text - see
  // store/index.ts's persist `migrate`/security.ts's encryptMnemonic for the
  // full reasoning). Now that the mnemonic is never persisted unencrypted,
  // step 1 naturally stops firing after any real reload (mnemonic is only
  // ever in live memory, not rehydrated), so this session cache is what
  // preserves the same "no passcode on a plain refresh" UX those wallets
  // already had - setWallet (store/index.ts) now populates it for every
  // non-social-auto source, not just import-privkey.
  if (walletSource !== 'social-auto') {
    try {
      const { getSessionPrivateKey } = await import('@/lib/security')
      const cached = await getSessionPrivateKey(walletAddress)
      if (cached) {
        // BUG FIX: this hardcoded 'import-privkey' as the 4th arg, which was
        // a harmless no-op back when this branch only ever ran for
        // import-privkey wallets, but silently CLOBBERED walletSource for a
        // create/import-seed wallet the moment this branch was widened to
        // cover them too. That matters beyond bookkeeping: ProfileSubPages'
        // BackupRecoveryPhrasePage gates whether the recovery-phrase tab
        // shows at all on walletSource - a real 'create' wallet restoring
        // through this exact path would have looked like an import-privkey
        // wallet (no seed phrase, ever) for the rest of that session.
        // Preserve whatever walletSource genuinely already was instead.
        setWallet(walletAddress, cached, mnemonic || undefined, walletSource || 'import-privkey')
        return true
      }
    } catch {}
  }

  // ── 3. create / import-seed / import-privkey: this device's local encrypted key ─
  // Never attempted for social-auto wallets - those never write a local
  // passcode-encrypted copy in the first place (see step 4), because the
  // passcode must never be part of how a social-auto wallet is encrypted.
  if (walletSource !== 'social-auto') {
    const passcodeOptions = [
      rawPasscode,
      pendingRawPasscode,
    ].filter(Boolean) as string[]

    if (passcodeOptions.length > 0) {
      try {
        const { getEncryptedKey, decryptPrivateKey } = await import('@/lib/security')
        const encKey = getEncryptedKey(walletAddress)
        if (encKey) {
          for (const code of passcodeOptions) {
            const key = await decryptPrivateKey(encKey, code)
            if (key) {
              setWallet(walletAddress, key, mnemonic || undefined, walletSource || 'import-privkey')
              return true
            }
          }
        }
      } catch {}
    }
  }

  // ── 4a. social-auto: this device's sealed copy (self-custodial) ────────────
  // Google / email wallets are made and kept on the device now (see
  // lib/socialWallet.ts). A reload opens the device-sealed copy; another
  // device opens the wallet with the passkey or Recovery QR on the Unlock
  // screen (/auth/recover-wallet) - those need a tap, so they never run from
  // here.
  if (walletSource === 'social-auto') {
    const { loadDeviceCopy } = await import('@/lib/socialWallet')
    const local = await loadDeviceCopy(walletAddress)
    if (local) {
      socialUnlockNeeded = false
      setWallet(walletAddress, local, undefined, 'social-auto')
      return true
    }
  }

  // ── 4b. social-auto without a copy here: passkey or Recovery QR ──────────
  // MeshPort's servers hold no copy of these wallets, so the only way in on
  // this device is the Unlock screen (needs a tap - never run from here).
  if (walletSource === 'social-auto') {
    socialUnlockNeeded = true
    return false
  }

  console.warn('[Restore] No recovery path available - walletSource:', walletSource, '- user needs to re-enter their recovery phrase or private key.')
  return false
}
