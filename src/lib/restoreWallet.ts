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
 * privy (Google / email accounts made since Privy) - Privy opens it for the
 * signed-in account (wallet/privy.ts); nothing is kept on the device.
 *
 * social-auto (older Google / email accounts) - the frame keeps a copy
 * sealed to this browser, opened without a prompt; there is no other copy
 * (passkey and Recovery QR backups were removed), so another device can't
 * open it. The app passcode is an APP LOCK ONLY for these.
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
let inFlightRestore: { promise: Promise<boolean>; passcode: string | null } | null = null

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
/**
 * What to tell someone whose wallet didn't open. Google / email (Privy)
 * accounts have no recovery phrase to re-import: their wallet comes back
 * with the sign-in.
 */
export function walletUnavailableMessage(): string {
  const src = useAuthStore.getState().walletSource
  return src === 'privy' || src === 'social-auto'
    ? "Your wallet didn't open - nothing was sent. Check your connection and try again; if it keeps happening, sign out and sign in again with Google / email."
    : "Couldn't access your wallet on this device. Sign out and re-import your wallet with your recovery phrase or private key to continue."
}

export async function restorePrivateKey(rawPasscode?: string, opts?: { silent?: boolean }): Promise<boolean> {
  const running = inFlightRestore
  if (running) {
    const ok = await running.promise
    // The attempt we joined may have started without this caller's passcode
    // (the mount-time restores in App / AppLayout / Home pass none). Its
    // failure says nothing about this passcode: a create / import wallet
    // after the lock screen stayed locked for the whole session, and the
    // next payment failed with "Couldn't access your wallet".
    if (ok || !rawPasscode || running.passcode === rawPasscode) return ok
    if (inFlightRestore === running) inFlightRestore = null
    return restorePrivateKey(rawPasscode, opts)
  }

  const promise = (async () => {
    const restored = await attemptRestore(rawPasscode)
    if (!opts?.silent) {
      const hasWallet = !!useAuthStore.getState().walletAddress
      useUIStore.getState().setWalletRecoveryNeeded(hasWallet && !restored)
    }
    return restored
  })()
  const entry = { promise, passcode: rawPasscode ?? null }
  inFlightRestore = entry

  try {
    return await promise
  } finally {
    if (inFlightRestore === entry) inFlightRestore = null
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

  // ── 1. a Privy wallet: Privy keeps the key in its secure hardware and opens
  // it for this signed-in account (src/wallet/privy.ts).
  if (walletSource === 'privy') {
    const { restorePrivyAccount, privyState } = await import('@/wallet/privy')
    const started = Date.now()
    // A known Privy account: wait for Privy to sign in and list the wallet.
    const account = await restorePrivyAccount(walletAddress, 30_000, 20_000)
    if (account) setWallet(walletAddress, account, 'privy')
    else {
      // Why it didn't open (client_errors): loaded? signed in? listed?
      void import('@/lib/errorReport').then(r => r.reportClientError('rejection',
        new Error(`[privy restore] no wallet after ${((Date.now() - started) / 1000).toFixed(1)} s: ${privyState(walletAddress)} online=${typeof navigator === 'undefined' || navigator.onLine}`))).catch(() => {})
    }
    return !!account
  }

  // ── 1a. 'social-auto' (an old Google/email account kept on this device):
  // a sign-in that gave up on a slow Privy also lands here with a real Privy
  // wallet. If Privy's record has the address, it's that - open it there.
  if (walletSource === 'social-auto') {
    const { restorePrivyAccount } = await import('@/wallet/privy')
    const account = await restorePrivyAccount(walletAddress, 20_000).catch(() => null)
    if (account) { setWallet(walletAddress, account, 'privy'); return true }
  }

  // ── 1b. a Circle wallet (switched off): Circle keeps the key; this browser keeps the
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

  console.warn('[Restore] No recovery path available - walletSource:', walletSource, '- user needs to re-enter their recovery phrase or private key.')
  return false
}
