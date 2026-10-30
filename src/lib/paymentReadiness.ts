// ── Payment readiness: the one way a payment gets its signer ────────────────
// Every screen that moves money (Pay, Chat pay, Swap, Bridge, Claim, P2P,
// Bulk pay, Business, Rewards...) goes through here instead of each reading
// `signer` from the store and calling restorePrivateKey its own way:
//
//   prepareSigner(passcode?)   - as early as possible (the moment the
//                                passcode is typed, or the screen opens):
//                                starts opening the wallet, warms a Privy
//                                wallet. Never waits, never shows a banner.
//   getReadySigner(passcode?)  - right before signing: the signer for THIS
//                                account, or null. Joins whatever
//                                prepareSigner started (restorePrivateKey is
//                                single-flight).
//   preparePayments()          - on a payment screen opening: the wallet plus
//                                Arc RPC and the pay-intent service.
//
// An address is never taken as a signer. The signer returned is checked to
// belong to the account still signed in (an account switch or logout while
// the wallet was opening returns null). The app lock doesn't close the
// wallet (store lock()), so preparing goes on behind the lock screen - but
// getReadySigner returns null while it's up: payments only run unlocked.

import { useEffect } from 'react'
import { useAuthStore } from '@/store'
import type { WalletAccount } from '@/wallet'
import { startWalletReadiness, walletGeneration, useWalletReadiness, type WalletPhase } from './walletReadiness'

/** Starts a Privy wallet's warm-up when it isn't warm yet. */
function warmPrivy(address: string): void {
  void import('@/wallet/privy')
    .then(m => { if (!m.privySignerConnected(address)) void m.warmPrivySigner(address) })
    .catch(() => {})
}

/**
 * Starts getting the signer ready without waiting: opens the wallet (with
 * the passcode when the person just typed it), warms a Privy wallet. Safe
 * to call any number of times.
 */
export function prepareSigner(passcode?: string): void {
  startWalletReadiness()
  const { walletAddress, walletSource, signer } = useAuthStore.getState()
  if (!walletAddress) return
  if (signer) {
    if (walletSource === 'privy') warmPrivy(walletAddress)
    return
  }
  // Silent: a mistyped passcode here must not raise the recovery banner.
  void import('./restoreWallet')
    .then(m => m.restorePrivateKey(passcode || undefined, { silent: true }))
    .catch(() => {})
}

/**
 * The signer for the signed-in account, opening the wallet if needed (with
 * `passcode` for created / imported wallets). Null when it can't be opened,
 * the app is locked, or the account changed meanwhile. Never throws.
 * `silent`: a failure doesn't raise the app-wide recovery banner.
 */
export async function getReadySigner(passcode?: string, opts?: { silent?: boolean }): Promise<WalletAccount | null> {
  startWalletReadiness()
  const start = useAuthStore.getState()
  if (!start.walletAddress || start.isLocked) return null
  const generation = walletGeneration()
  let signer = start.signer
  if (!signer) {
    try {
      const { restorePrivateKey } = await import('./restoreWallet')
      if (!(await restorePrivateKey(passcode || undefined, opts))) return null
    } catch {
      return null
    }
    signer = useAuthStore.getState().signer
  }
  const now = useAuthStore.getState()
  if (!signer || generation !== walletGeneration() || !now.walletAddress) return null
  if (signer.address.toLowerCase() !== now.walletAddress.toLowerCase()) return null
  if (now.walletSource === 'privy') warmPrivy(now.walletAddress)
  return signer
}

/** On a payment screen opening: the wallet, Arc RPC and the pay-intent service, all at once. */
export function preparePayments(): void {
  prepareSigner()
  void import('./arcService').then(m => m.warmArcRpc()).catch(() => {})
  void import('./payIntentService').then(m => { void m.warmPayIntent() }).catch(() => {})
}

/** preparePayments() once when a payment screen mounts. */
export function usePreparePayments(): void {
  useEffect(() => { preparePayments() }, [])
}

/** The wallet's readiness for a payment screen's own display ("Opening your wallet…"). */
export function usePaymentReadiness(): { phase: WalletPhase; ready: boolean; opening: boolean } {
  const phase = useWalletReadiness(s => s.phase)
  return {
    phase,
    ready: phase === 'signer_ready',
    opening: phase === 'initializing' || phase === 'recovering' || phase === 'wallet_discovered',
  }
}
