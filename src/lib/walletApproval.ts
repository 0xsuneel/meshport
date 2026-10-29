// ── Approving value-moving signatures in the wallet frame ───────────────────
// The wallet frame (create / import wallets) signs transactions, permits and
// Solana transactions only within 2 minutes of the person's passcode, checked
// by the frame itself (wallet-frame/src/main.ts, "Approval"). So:
//   - every passcode / fingerprint that passes in the app (verifyPasscode)
//     is handed to the frame here - the existing PIN sheets need no change;
//   - an action the frame refuses ("approval-required" - one with no PIN
//     step of its own, or after the 2 minutes) asks for the passcode once,
//     on one shared sheet (WalletApprovalPrompt), then runs again;
//   - background work (claims finishing, recoveries, expired P2P trades)
//     never asks: it runs only while an approval is fresh (`approvalFresh`)
//     and otherwise waits for the next passcode.
// Google / email (Privy) wallets aren't in the frame - nothing to do here.

import { create } from 'zustand'
import { useAuthStore } from '@/store'
import { FRAME_PASSCODE, WALLET_UNAVAILABLE, hashPasscode, onPasscodeVerified, setFramePasscodeCheck } from './security'

const FRAME_SOURCES = new Set(['create', 'import-seed', 'import-privkey', 'social-auto'])
// A little under the frame's own 2 minutes, so a job that starts never runs out.
const FRESH_MS = 100_000
let approvedAt = 0

function frameWallet(): string | null {
  const { walletAddress, walletSource } = useAuthStore.getState()
  return walletAddress && walletSource && FRAME_SOURCES.has(walletSource) ? walletAddress : null
}

/**
 * Hand the passcode to the frame. `required`: the frame really checked it
 * (this wallet has a passcode there). `error` is the frame's code when it
 * refused it.
 */
export async function approveWallet(passcode: string): Promise<{ ok: boolean; required?: boolean; error?: string; lockedForMs?: number }> {
  const address = frameWallet()
  if (!address || !passcode) return { ok: true }
  try {
    const { approveFrameWallet } = await import('@/wallet')
    const { required } = await approveFrameWallet(address, passcode)
    approvedAt = Date.now()
    return { ok: true, required }
  } catch (e) {
    const { code, lockedForMs } = e as { code?: string; lockedForMs?: number }
    return { ok: false, error: code ?? 'failed', lockedForMs }
  }
}

// The passcode check itself, for wallets whose passcode lives only in the
// frame (security.ts FRAME_PASSCODE). A frame with no passcode for this
// wallet never counts as a match.
setFramePasscodeCheck(async passcode => {
  const r = await approveWallet(passcode)
  if (r.ok) return r.required === true
  if (r.error === 'bad-passcode' || r.error === 'rate-limited') return false
  throw new Error(WALLET_UNAVAILABLE)
})

onPasscodeVerified(async passcode => {
  const r = await approveWallet(passcode)
  // The frame checked this passcode itself: the app's own hash is no longer
  // needed - and is the one thing a copy of this page's storage could be
  // brute-forced from. Keep only the marker from now on.
  const stored = useAuthStore.getState().passcode
  if (r.ok && r.required && stored !== FRAME_PASSCODE) {
    useAuthStore.getState().setPasscode(FRAME_PASSCODE)
  } else if (stored && stored !== FRAME_PASSCODE && !stored.startsWith('v3:')) {
    // An older format (the passcode itself, a 100k-round or localStorage-salt
    // hash): the current 600k-round hash instead, now that it has passed.
    useAuthStore.getState().setPasscode(await hashPasscode(passcode))
  }
  // The app accepted this passcode but the frame's copy is sealed with a
  // different one: value-moving signatures from this wallet would be refused.
  if (r.error === 'bad-passcode') {
    void import('./errorReport').then(m => m.reportClientError('rejection', new Error('[wallet approval] the wallet frame refused a passcode the app accepted'))).catch(() => {})
  }
})

/** An approval from the last ~2 minutes is in place (background work may sign). */
export function approvalFresh(): boolean {
  return !frameWallet() || Date.now() - approvedAt < FRESH_MS
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
