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
import type { WalletAccount } from '@/wallet'
import { walletGeneration, noteRestoring, startWalletReadiness } from './walletReadiness'

// ── Single-flight guard ─────────────────────────────────────────────────────
// There are 13+ call sites of restorePrivateKey() across the app, several
// firing automatically on mount. Sharing one in-flight attempt avoids
// redundant concurrent network calls when multiple components ask at once.
let inFlightRestore: { promise: Promise<boolean>; passcode: string | null; generation: number } | null = null

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
  startWalletReadiness()
  const running = inFlightRestore
  // An attempt for an account that has since logged out / switched is not
  // this caller's: start a fresh one (its own result is dropped - commit()).
  if (running && running.generation !== walletGeneration()) {
    inFlightRestore = null
    return restorePrivateKey(rawPasscode, opts)
  }
  if (running) {
    const ok = await running.promise
    // The attempt we joined may have started without this caller's passcode
    // (the mount-time restores in App / AppLayout / Home pass none). Its
    // failure says nothing about this passcode: a create / import wallet
    // after the lock screen stayed locked for the whole session, and the
    // next payment failed with "Couldn't access your wallet".
    // Google / email wallets open without a passcode: the result stands.
    const samePasscode = running.passcode === rawPasscode || !passcodeOpens(useAuthStore.getState().walletSource)
    if (ok || !rawPasscode || samePasscode) {
      // A silent attempt sets no banner. This caller isn't silent: show it,
      // unless that attempt had a passcode this caller doesn't - it may have
      // been a typo, which isn't a reason for "recover your wallet".
      if (!ok && !opts?.silent && (samePasscode || running.passcode === null)) {
        const { walletAddress, signer } = useAuthStore.getState()
        useUIStore.getState().setWalletRecoveryNeeded(!!walletAddress && !signer)
      }
      return ok
    }
    if (inFlightRestore === running) inFlightRestore = null
    return restorePrivateKey(rawPasscode, opts)
  }

  const generation = walletGeneration()
  const promise = (async () => {
    noteRestoring(true)
    let outcome: Outcome = { ok: false, error: 'failed' }
    try {
      outcome = await attemptRestore(generation, rawPasscode)
    } finally {
      noteRestoring(false, outcome.ok === false ? outcome.error : null)
    }
    // Logged out / switched meanwhile: nothing to say about the new account.
    if (generation !== walletGeneration()) return false
    if (!opts?.silent) {
      const hasWallet = !!useAuthStore.getState().walletAddress
      useUIStore.getState().setWalletRecoveryNeeded(hasWallet && !outcome.ok)
    }
    return outcome.ok
  })()
  const entry = { promise, passcode: rawPasscode ?? null, generation }
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

/** Whether a passcode can open this kind of wallet (the frame's passcode copy: created / imported). */
function passcodeOpens(walletSource: string | null | undefined): boolean {
  return walletSource !== 'privy' && walletSource !== 'social-auto' && walletSource !== 'circle'
}

/** ok, or why not: null = it needs the passcode / an unlock (not an error). */
type Outcome = { ok: true } | { ok: false; error: string | null }
const OK: Outcome = { ok: true }
const fail = (error: string | null): Outcome => ({ ok: false, error })

/**
 * Put the opened wallet in the store - only if it still belongs to the
 * account this attempt started for. A restore can wait tens of seconds
 * (Privy signing in, the wallet frame on a weak connection); setWallet with
 * the address captured at the start used to bring a logged-out wallet back.
 */
function commit(generation: number, address: string, account: WalletAccount, source?: Parameters<ReturnType<typeof useAuthStore.getState>['setWallet']>[2]): boolean {
  const cur = useAuthStore.getState()
  if (generation !== walletGeneration() || cur.walletAddress?.toLowerCase() !== address.toLowerCase()) return false
  cur.setWallet(address, account, source)
  return true
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function attemptRestore(generation: number, rawPasscode?: string): Promise<Outcome> {
  const { walletAddress, signer, walletSource } = useAuthStore.getState()

  if (signer) {
    // A Privy signer object can exist while Privy hasn't authenticated the
    // wallet yet (walletReadiness 'wallet_discovered'): start its warm-up so
    // the first payment doesn't pay for it. Not awaited - the signer itself
    // waits for Privy's connection when it signs, and readiness reports
    // 'signer_ready' only once the warm-up answers (untilSignerReady).
    if (walletSource === 'privy' && walletAddress) {
      void import('@/wallet/privy').then(m => { if (!m.privySignerConnected(walletAddress)) void m.warmPrivySigner(walletAddress) }).catch(() => {})
    }
    return OK
  }
  if (!walletAddress) return fail(null)

  // ── 1. a Privy wallet: Privy keeps the key in its secure hardware and opens
  // it for this signed-in account (src/wallet/privy.ts).
  if (walletSource === 'privy') {
    const { restorePrivyAccount, privyState } = await import('@/wallet/privy')
    const started = Date.now()
    // A known Privy account: wait for Privy to sign in and list the wallet.
    const account = await restorePrivyAccount(walletAddress, 30_000, 20_000)
    if (account) return commit(generation, walletAddress, account, 'privy') ? OK : fail('account changed')
    else {
      // Why it didn't open (client_errors): loaded? signed in? listed?
      void import('@/lib/errorReport').then(r => r.reportClientError('rejection',
        new Error(`[privy restore] no wallet after ${((Date.now() - started) / 1000).toFixed(1)} s: ${privyState(walletAddress)} online=${typeof navigator === 'undefined' || navigator.onLine}`))).catch(() => {})
    }
    return fail(`privy: ${privyState(walletAddress)}`)
  }

  // ── 1a. 'social-auto' (an old Google/email account kept on this device):
  // a sign-in that gave up on a slow Privy also lands here with a real Privy
  // wallet. If Privy's record has the address, it's that - open it there.
  if (walletSource === 'social-auto') {
    const { restorePrivyAccount } = await import('@/wallet/privy')
    const account = await restorePrivyAccount(walletAddress, 20_000).catch(() => null)
    if (account) return commit(generation, walletAddress, account, 'privy') ? OK : fail('account changed')
  }

  // ── 1b. a Circle wallet (switched off): Circle keeps the key; this browser keeps the
  // Circle session. Without it the user signs in to Circle again.
  if (walletSource === 'circle') {
    const { restoreCircleAccount } = await import('@/wallet/circle')
    const account = await restoreCircleAccount(walletAddress).catch(() => null)
    if (account) return commit(generation, walletAddress, account, 'circle') ? OK : fail('account changed')
    return fail('circle session not found')
  }

  const wallet = await import('@/wallet')
  const passcodes = (walletSource === 'social-auto' ? [] : [rawPasscode, pendingRawPasscode]).filter(Boolean) as string[]

  // ── 2. the frame's session / device copy - no prompt ──────────────────────
  // A frame that timed out or didn't load (weak connection, a slow phone)
  // gets two more tries (1 s, 3 s) - it used to leave the wallet closed until
  // the person did something. A real answer ("locked") isn't retried.
  for (let attempt = 0; ; attempt++) {
    try {
      const open = await wallet.unlockWallet(walletAddress)
      if (open) {
        if (!commit(generation, walletAddress, open, walletSource || undefined)) return fail('account changed')
        // Finish moving an old app-side passcode copy once a passcode is known.
        if (passcodes.length) void wallet.migrateLegacyKey(walletAddress, walletSource, passcodes).catch(() => {})
        return OK
      }
      break
    } catch (e) {
      const transient = e instanceof wallet.WalletFrameError && (e.code === 'timeout' || e.code === 'unavailable')
      if (!transient || attempt >= 2 || generation !== walletGeneration()) {
        // Frame unreachable (blocked, offline first load): nothing else can
        // open the key either - the app no longer holds one.
        console.warn('[Restore] wallet frame unavailable:', e)
        return fail('wallet frame unavailable')
      }
      await sleep(attempt === 0 ? 1000 : 3000)
    }
  }

  // ── 3. keys the app held before the frame existed ─────────────────────────
  try {
    const moved = await wallet.migrateLegacyKey(walletAddress, walletSource, passcodes)
    if (moved) return commit(generation, walletAddress, moved, walletSource || undefined) ? OK : fail('account changed')
  } catch (e) { console.warn('[Restore] moving the old key into the wallet frame failed:', e) }

  // ── 4. create / import-*: the frame's passcode copy ───────────────────────
  for (const code of passcodes) {
    try {
      const open = await wallet.unlockWallet(walletAddress, code)
      if (open) return commit(generation, walletAddress, open, walletSource || undefined) ? OK : fail('account changed')
    } catch (e) {
      // Wrong passcode: try the next one. Locked out: stop - every further
      // try only extends the wait.
      if (e instanceof wallet.WalletFrameError && e.code === 'rate-limited') break
    }
  }

  // No passcode given: it simply needs one (the lock screen / payment asks) - not an error.
  if (!passcodes.length && passcodeOpens(walletSource)) return fail(null)
  console.warn('[Restore] No recovery path available - walletSource:', walletSource, '- user needs to re-enter their recovery phrase or private key.')
  return fail(passcodes.length ? 'passcode did not open the wallet' : 'no copy of the wallet on this device')
}
