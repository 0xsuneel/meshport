// ── Wallet readiness: one answer to "can this wallet sign right now?" ───────
// Kept apart on purpose - a stored address is not a signer, a Privy account
// that lists the wallet isn't one either until Privy's wallet iframe has
// connected, and the app's own lock screen is not the wallet's state:
//
//   phase         idle               signed out
//                 authenticated      signed in, no wallet address yet
//                 initializing       the wallet is being opened (restoreWallet)
//                 recovering         it was open this session and is being opened again
//                 wallet_discovered  the provider knows the wallet, signing not connected yet (Privy)
//                 signer_ready       it can sign
//                 locked             it needs the passcode / an unlock to open
//                 error              the last open failed (`error` says why) - retryable
//   authenticated signed in
//   appLocked     the app's lock screen is up (separate from the wallet)
//   networkReady  Arc RPC has answered at least once
//
// `generation` changes whenever the wallet address does (logout, account
// switch): a restore that started for an older generation must not write
// its result (restoreWallet.ts checks it before setWallet).

import { create } from 'zustand'
import { useAuthStore } from '@/store'
import { markStartup, reportResume } from './perfTrace'

export type WalletPhase =
  | 'idle' | 'authenticated' | 'initializing' | 'recovering'
  | 'wallet_discovered' | 'signer_ready' | 'locked' | 'error'

export interface WalletReadiness {
  phase: WalletPhase
  authenticated: boolean
  appLocked: boolean
  networkReady: boolean
  error: string | null
}

export const useWalletReadiness = create<WalletReadiness>(() => ({
  phase: 'idle', authenticated: false, appLocked: false, networkReady: false, error: null,
}))

let generation = 0
let restoring = false
let lastError: string | null = null
let hadSigner = false
// Privy: is the wallet's signing iframe connected? Set once Privy's module is loaded.
let privyConnected: ((address: string) => boolean) | null = null

/** Changes on logout / account switch - see the file comment. */
export function walletGeneration(): number { return generation }

/** restoreWallet.ts: an open is running / finished (with an error, or null). */
export function noteRestoring(on: boolean, error: string | null = null): void {
  restoring = on
  if (!on) lastError = error
  else lastError = null
  recompute()
}

/** The first Arc RPC answer (arc.ts sends ARC_RPC_OK_EVENT). */
export const ARC_RPC_OK_EVENT = 'meshport:arc-rpc-ok'
export function noteNetworkReady(): void {
  if (useWalletReadiness.getState().networkReady) return
  markStartup('rpc')
  useWalletReadiness.setState({ networkReady: true })
}

/** privy.ts: lets readiness tell "listed" from "can sign". */
export function setPrivyConnectedProbe(probe: (address: string) => boolean): void {
  privyConnected = probe
  recompute()
}

export function recompute(): void {
  const { walletAddress, walletSource, signer, isAuthenticated, isLocked } = useAuthStore.getState()
  let phase: WalletPhase
  if (!walletAddress) phase = isAuthenticated ? 'authenticated' : 'idle'
  else if (signer) {
    const privyWaiting = walletSource === 'privy' && (!privyConnected || !privyConnected(walletAddress))
    phase = privyWaiting ? 'wallet_discovered' : 'signer_ready'
  } else if (restoring) phase = hadSigner ? 'recovering' : 'initializing'
  else if (lastError) phase = 'error'
  else phase = 'locked'

  if (phase === 'wallet_discovered' || phase === 'signer_ready') markStartup('discovered')
  if (phase === 'signer_ready') { markStartup('signer'); hadSigner = true; finishResume() }

  const prev = useWalletReadiness.getState()
  const next = { phase, authenticated: isAuthenticated, appLocked: isLocked, error: phase === 'error' ? lastError : null }
  if (prev.phase !== next.phase || prev.authenticated !== next.authenticated || prev.appLocked !== next.appLocked || prev.error !== next.error) {
    useWalletReadiness.setState(next)
  }
}

// Coming back to a page whose wallet had closed (a discarded tab, a provider
// that dropped): how long until it signs again.
let resumeStartedAt: number | null = null
function finishResume(): void {
  if (resumeStartedAt == null) return
  reportResume(performance.now() - resumeStartedAt, 'reopened')
  resumeStartedAt = null
}

let started = false
/** Wire readiness to the auth store (once). Safe to call from several places. */
export function startWalletReadiness(): void {
  if (started) return
  started = true
  let prevAddress = useAuthStore.getState().walletAddress?.toLowerCase() ?? null
  if (useAuthStore.getState().isAuthenticated) markStartup('auth')
  useAuthStore.subscribe(state => {
    const addr = state.walletAddress?.toLowerCase() ?? null
    if (addr !== prevAddress) {
      // Logout / another account: anything still opening belongs to the old one.
      generation++
      prevAddress = addr
      lastError = null
      hadSigner = false
    }
    if (state.isAuthenticated) markStartup('auth')
    recompute()
  })
  if (typeof window !== 'undefined') window.addEventListener(ARC_RPC_OK_EVENT, noteNetworkReady)
  if (typeof document !== 'undefined') {
    // Back in the foreground / back online with the wallet closed: open it
    // again through restorePrivateKey, which joins any open already running -
    // never a second, overlapping one. Also behind the lock screen (an app
    // lock only - store lock()): what opens without a passcode is ready the
    // moment it's unlocked; a created / imported wallet still needs the
    // passcode the lock screen asks for. A wallet that's open is left alone.
    const reopen = () => {
      const { walletAddress, signer } = useAuthStore.getState()
      if (!walletAddress || signer) return
      if (hadSigner && resumeStartedAt == null) resumeStartedAt = performance.now()
      void import('./restoreWallet').then(m => m.restorePrivateKey(undefined, { silent: true })).catch(() => {})
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reopen() })
    window.addEventListener('online', reopen)
  }
  recompute()
}

/**
 * Resolves true once the wallet can sign (signer_ready), false if it settles
 * without that (locked, error, signed out) - or after `timeoutMs`, so no
 * caller can wait forever on a phase that never settles (a Privy wallet
 * whose warm-up keeps failing stays 'wallet_discovered'). Event-driven.
 */
export function untilSignerReady(timeoutMs = 60_000): Promise<boolean> {
  const settled = (p: WalletPhase): boolean | null =>
    p === 'signer_ready' ? true : p === 'error' || p === 'locked' || p === 'idle' ? false : null
  return new Promise(resolve => {
    const now = settled(useWalletReadiness.getState().phase)
    if (now !== null) { resolve(now); return }
    const unsub = useWalletReadiness.subscribe(s => {
      const v = settled(s.phase)
      if (v !== null) { clearTimeout(timer); unsub(); resolve(v) }
    })
    const timer = setTimeout(() => { unsub(); resolve(false) }, timeoutMs)
  })
}

/** Test hook. */
export function resetWalletReadiness(): void {
  generation = 0; restoring = false; lastError = null; hadSigner = false; privyConnected = null; resumeStartedAt = null
}
