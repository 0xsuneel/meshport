/**
 * Wallet restoration - opening the wallet in the wallet frame.
 *
 * The key lives only in the wallet frame (src/wallet, wallet-frame/) on its
 * own origin; "restoring" means asking the frame to open it and putting the
 * resulting signer (a WalletAccount - address + sign-through-the-frame) in
 * the auth store. Recovery models are unchanged:
 *
 * create / import-seed / import-privkey - NO server-side fallback, by
 * design. MeshPort never stores these wallets' private key or recovery
 * phrase on its servers, in any form. The frame keeps a passcode-encrypted
 * copy on this device; otherwise the user re-enters the phrase / key.
 *
 * social-auto (Google AND Email-OTP accounts) - SELF-CUSTODIAL. The frame
 * keeps a copy sealed to this browser; another device opens the wallet with
 * the account's passkey (lib/walletPasskey.ts) or Recovery QR
 * (lib/recoveryQr.ts). The app passcode is an APP LOCK ONLY for these.
 *
 * Priority order:
 * 1. Already open → done
 * 2. Frame without a prompt: this tab's session copy, or (social-auto) the
 *    device copy - a plain refresh skips the passcode.
 * 3. Keys the app held before the frame existed (session copy, social
 *    device copy, passcode copy) are handed to the frame once and deleted
 *    from the app's origin (wallet/index.ts migrateLegacyKey).
 * 4. create / import-*: the frame's passcode copy, with the passcode the
 *    caller has (just typed / stashed). Never for social-auto.
 * 5. social-auto with no copy here: needsSocialUnlock() → the Unlock screen
 *    (passkey / Recovery QR), which needs a tap and so never runs from here.
 *
 * If none of these work, `walletRecoveryNeeded` is set on the UI store,
 * which drives a persistent, app-wide banner (see
 * components/layout/WalletRecoveryBanner.tsx) pointing the user at
 * ImportWalletPage to re-enter their recovery phrase manually.
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
  const { walletAddress, signer, walletSource, setWallet } = useAuthStore.getState()

  if (signer) return true
  if (!walletAddress) return false

  // ── 1. a Circle wallet: Circle keeps the key; this browser keeps the
  // Circle session. Without it the user signs in to Circle again.
  if (walletSource === 'circle') {
    const { restoreCircleAccount } = await import('@/wallet/circle')
    const account = await restoreCircleAccount(walletAddress).catch(() => null)
    if (account) setWallet(walletAddress, account, 'circle')
    return !!account
  }

  const wallet = await import('@/wallet')
  const passcodes = (walletSource === 'social-auto' ? [] : [rawPasscode, pendingRawPasscode]).filter(Boolean) as string[]

  // ── 2. the frame's session / device copy - no prompt ──────────────────────
  try {
    const open = await wallet.unlockWallet(walletAddress)
    if (open) {
      socialUnlockNeeded = false
      setWallet(walletAddress, open, walletSource || undefined)
      // Finish moving an old app-side passcode copy once a passcode is known.
      if (passcodes.length) void wallet.migrateLegacyKey(walletAddress, walletSource, passcodes).catch(() => {})
      return true
    }
  } catch (e) {
    // Frame unreachable (blocked, offline first load): nothing else can open
    // the key either - the app no longer holds one.
    console.warn('[Restore] wallet frame unavailable:', e)
    return false
  }

  // ── 3. keys the app held before the frame existed ─────────────────────────
  try {
    const moved = await wallet.migrateLegacyKey(walletAddress, walletSource, passcodes)
    if (moved) {
      socialUnlockNeeded = false
      setWallet(walletAddress, moved, walletSource || undefined)
      return true
    }
  } catch (e) { console.warn('[Restore] moving the old key into the wallet frame failed:', e) }

  // ── 4. create / import-*: the frame's passcode copy ───────────────────────
  for (const code of passcodes) {
    try {
      const open = await wallet.unlockWallet(walletAddress, code)
      if (open) { setWallet(walletAddress, open, walletSource || undefined); return true }
    } catch (e) {
      // Wrong passcode: try the next one. Locked out: stop - every further
      // try only extends the wait.
      if (e instanceof wallet.WalletFrameError && e.code === 'rate-limited') break
    }
  }

  // ── 5. social-auto without a copy here: passkey or Recovery QR ────────────
  if (walletSource === 'social-auto') {
    socialUnlockNeeded = true
    return false
  }

  console.warn('[Restore] No recovery path available - walletSource:', walletSource, '- user needs to re-enter their recovery phrase or private key.')
  return false
}
