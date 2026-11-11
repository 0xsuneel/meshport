// ── Confirming inside the wallet ─────────────────────────────────────────────
// The passcode step of a value-moving action happens in the wallet frame's
// own page (wallet-frame/confirm.html), shown in the app's passcode sheet as
// an iframe (components/wallet/WalletConfirmFrame). The passcode is typed -
// or the fingerprint used - inside the wallet's origin and checked there; the
// app never sees it, so nothing running in the app can record it.
//
//   With an intent (Pay): the wallet decodes the transaction itself, shows
//   recipient, amount and token from it, and signs only that transaction,
//   once (wallet/account.ts bindConfirmation). No approval window opens.
//   With a summary only (swap, bridge, claim...: their transactions are
//   built by Circle's SDK after the passcode): the app's description is
//   shown as such, and a correct passcode opens the usual 2-minute approval
//   window (lib/walletApproval).
//
// The existing screens keep their flow: once approved, the sheet hands the
// screen a token in place of the passcode (`isWalletConfirmToken`). The
// passcode checks (security.verifyPasscode), wallet opening
// (restoreWallet.restorePrivateKey) and approvals (walletApproval) accept it
// as "the wallet checked the passcode" - the frame already opened the key.

import { useAuthStore } from '@/store'
import type { ConfirmIntent, ConfirmSummary } from '@/wallet/protocol'
import { issueWalletConfirmToken } from './walletConfirmToken'

export { isWalletConfirmToken, walletConfirmTokenValid } from './walletConfirmToken'

const FRAME_SOURCES = new Set(['create', 'import-seed', 'import-privkey'])

// The frame doesn't have confirm.html yet (it's deployed on its own): the
// app's own keypad, for the rest of this session.
let unsupported = false
export function noteConfirmUnsupported(): void { unsupported = true }

/** The signed-in wallet's address when it can confirm in the wallet frame. */
export function walletConfirmAddress(): string | null {
  if (unsupported || typeof BroadcastChannel === 'undefined') return null
  const { walletAddress, walletSource, passcode } = useAuthStore.getState()
  if (!walletAddress || !walletSource || !FRAME_SOURCES.has(walletSource) || !passcode) return null
  return walletAddress
}

/** Start a confirmation for the signed-in wallet: the iframe URL and its ticket. */
export async function startWalletConfirm(request: { intent?: ConfirmIntent | null; summary: ConfirmSummary }, theme: 'dark' | 'light'): Promise<{ ticket: string; url: string; address: string }> {
  const address = walletConfirmAddress()
  if (!address) throw new Error('unavailable')
  const { biometricEnabled } = useAuthStore.getState()
  const biometric = biometricEnabled ? await import('./biometric').then(m => m.biometricSealFor(address)).catch(() => null) : null
  const { beginConfirm } = await import('@/wallet')
  const { ticket, url } = await beginConfirm(address, { intent: request.intent ?? undefined, summary: request.summary, biometric }, theme)
  return { ticket, url, address }
}

/** The wallet approved `ticket`: bind it (intent) or note the open window, and return the token. */
export async function finishWalletConfirm(address: string, ticket: string, intent?: ConfirmIntent | null): Promise<string> {
  if (intent) {
    const { bindConfirmation } = await import('@/wallet/account')
    bindConfirmation(address, intent, ticket)
  } else {
    const { noteWalletApproved } = await import('./walletApproval')
    noteWalletApproved(address)
  }
  return issueWalletConfirmToken(ticket)
}

// A Pay send's fees stay far under this (≈0.002 USDC on Arc); the wallet
// shows it as the most the payment may spend on fees.
const PAY_MAX_FEE = 50_000_000_000_000_000n // 0.05 USDC

/** The exact transaction a Pay send will sign (arcService payTx), for the wallet to confirm. */
export async function payConfirmIntent(token: 'USDC' | 'EURC' | 'cirBTC', to: string, amount: number, memo?: { code: string; label: string } | null): Promise<ConfirmIntent | null> {
  try {
    const [{ payTx, isValidAddress, ARC_CHAIN_INLINE }, { getAddress }] = await Promise.all([import('./arcService'), import('viem')])
    if (!isValidAddress(to) || !(amount > 0)) return null
    const tx = payTx(token, getAddress(to), amount, token === 'USDC' ? memo ?? null : null)
    return { chainId: ARC_CHAIN_INLINE.id, to: tx.to, value: String(tx.value ?? 0n), data: (tx.data ?? '0x') as `0x${string}`, maxFee: String(PAY_MAX_FEE) }
  } catch {
    return null
  }
}
