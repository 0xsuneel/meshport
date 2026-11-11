// ── Approving value-moving signatures in the wallet frame ───────────────────
// The wallet frame (create / import wallets) signs transactions, permits and
// Solana transactions only after the person approved them on the frame's own
// page (wallet-frame/confirm.html, lib/walletConfirm) - the passcode or
// fingerprint is entered there, inside the wallet origin, never in the app.
// A payment is confirmed with its exact transaction; other actions open a
// 2-minute approval window. So:
//   - a passcode typed in the app (lock screen, a keypad fallback) is only
//     CHECKED by the frame here ('passcode:check', with its lockout) - it
//     approves nothing;
//   - an action the frame refuses ("approval-required" - one with no PIN
//     step of its own, or after the 2 minutes) asks once, on one shared
//     sheet (WalletApprovalPrompt - the wallet's own page), then runs again;
//   - background work (claims finishing, recoveries, expired P2P trades)
//     never asks: it runs only while an approval is fresh (`approvalFresh`)
//     and otherwise waits for the next one.

import { create } from 'zustand'
import { useAuthStore } from '@/store'
import { FRAME_PASSCODE, WALLET_UNAVAILABLE, onPasscodeVerified, setFramePasscodeCheck } from './security'
import { isWalletConfirmToken, walletConfirmTokenValid } from './walletConfirmToken'

const FRAME_SOURCES = new Set(['create', 'import-seed', 'import-privkey'])
// A little under the frame's own 2 minutes, so a job that starts never runs out.
const FRESH_MS = 100_000
// Per wallet: an approval for one wallet says nothing about another.
const approvedAt = new Map<string, number>()

function frameWallet(): string | null {
  const { walletAddress, walletSource } = useAuthStore.getState()
  return walletAddress && walletSource && FRAME_SOURCES.has(walletSource) ? walletAddress : null
}

/**
 * Have the frame check a passcode (approves nothing). A wallet-confirmed
 * token (lib/walletConfirm) was checked on the wallet's page already.
 * `error` is the frame's code when it refused it.
 */
export async function checkWalletPasscode(passcode: string): Promise<{ ok: boolean; error?: string; lockedForMs?: number }> {
  const address = frameWallet()
  if (!address || !passcode) return { ok: true }
  if (isWalletConfirmToken(passcode)) return walletConfirmTokenValid(passcode) ? { ok: true } : { ok: false, error: 'bad-passcode' }
  try {
    const { checkFramePasscode } = await import('@/wallet')
    await checkFramePasscode(address, passcode)
    return { ok: true }
  } catch (e) {
    const { code, lockedForMs } = e as { code?: string; lockedForMs?: number }
    return { ok: false, error: code ?? 'failed', lockedForMs }
  }
}

// The passcode check itself, for wallets whose passcode lives only in the
// frame (security.ts FRAME_PASSCODE).
setFramePasscodeCheck(async passcode => {
  const r = await checkWalletPasscode(passcode)
  if (r.ok) return true
  if (r.error === 'bad-passcode' || r.error === 'rate-limited') return false
  throw new Error(WALLET_UNAVAILABLE)
})

onPasscodeVerified(async passcode => {
  // Checked by the frame already (the marker) or on its own page (a token).
  if (isWalletConfirmToken(passcode) || !frameWallet() || useAuthStore.getState().passcode === FRAME_PASSCODE) return
  // A passcode the app checked against its own hash: have the frame check it
  // too. Once it has, the app's hash is no longer needed - and is the one
  // thing a copy of this page's storage could be brute-forced from. Keep
  // only the marker from now on.
  const r = await checkWalletPasscode(passcode)
  const stored = useAuthStore.getState().passcode
  if (r.ok && stored !== FRAME_PASSCODE) useAuthStore.getState().setPasscode(FRAME_PASSCODE)
  // The app accepted this passcode but the frame's copy is sealed with a
  // different one: value-moving signatures from this wallet would be refused.
  if (r.error === 'bad-passcode') {
    void import('./errorReport').then(m => m.reportClientError('rejection', new Error('[wallet approval] the wallet frame refused a passcode the app accepted'))).catch(() => {})
  }
})

/** The wallet's own confirm page opened the approval window (lib/walletConfirm). */
export function noteWalletApproved(address: string): void {
  approvedAt.set(address.toLowerCase(), Date.now())
}

/** An approval from the last ~2 minutes is in place (background work may sign). */
export function approvalFresh(): boolean {
  const address = frameWallet()
  return !address || Date.now() - (approvedAt.get(address.toLowerCase()) ?? 0) < FRESH_MS
}

// ── The shared passcode sheet ────────────────────────────────────────────────
interface ApprovalPrompt { open: boolean; resolve: ((ok: boolean) => void) | null }
export const useApprovalPrompt = create<ApprovalPrompt>(() => ({ open: false, resolve: null }))

let quiet = 0
/** Run background signing work: a refusal there never opens the sheet. */
export async function inBackground<T>(work: () => Promise<T>): Promise<T> {
  quiet++
  try { return await work() } finally { quiet-- }
}

let pending: Promise<boolean> | null = null
/** Ask for the passcode on the shared sheet. True once the frame accepted it. */
export function requestWalletApproval(): Promise<boolean> {
  if (quiet > 0) return Promise.resolve(false)
  if (pending) return pending
  pending = new Promise<boolean>(resolve => {
    useApprovalPrompt.setState({ open: true, resolve: ok => { pending = null; useApprovalPrompt.setState({ open: false, resolve: null }); resolve(ok) } })
  })
  return pending
}
