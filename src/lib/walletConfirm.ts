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
//   With a scope (swap, bridge, claim, P2P...: their transactions are built
//   by Circle's SDK or the screen after the passcode): a spend limit. For 2
//   minutes the wallet decodes every signature and counts what it moves
//   against it; one over the limit, or one it can't read, is refused and
//   then confirmed on its own (lib/walletApproval).
//   With a request: one exact signature request (WalletApprovalPrompt).
//   The app's summary is shown beside these, as the app's own words.
//
// The existing screens keep their flow: once approved, the sheet hands the
// screen a token in place of the passcode (`isWalletConfirmToken`). The
// passcode checks (security.verifyPasscode), wallet opening
// (restoreWallet.restorePrivateKey) and approvals (walletApproval) accept it
// as "the wallet checked the passcode" - the frame already opened the key.

import { useAuthStore } from '@/store'
import type { ConfirmIntent, ConfirmRequest, ConfirmScope, ConfirmSummary } from '@/wallet/protocol'
import { issueWalletConfirmToken } from './walletConfirmToken'
import { routerAddressesRaw } from './gaslessRouters'

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
export interface WalletConfirmWhat { intent?: ConfirmIntent | null; scope?: ConfirmScope | null; request?: ConfirmRequest | null; summary: ConfirmSummary }
/** `slot`: the name of the confirm page the app already opened (confirm.html#slot=), so it can take the passcode while this runs. */
export async function startWalletConfirm(what: WalletConfirmWhat, theme: 'dark' | 'light', slot?: string): Promise<{ ticket: string; url: string; address: string }> {
  const address = walletConfirmAddress()
  if (!address) throw new Error('unavailable')
  const { biometricEnabled } = useAuthStore.getState()
  const biometric = biometricEnabled ? await import('./biometric').then(m => m.biometricSealFor(address)).catch(() => null) : null
  const { beginConfirm } = await import('@/wallet')
  const { ticket, url } = await beginConfirm(address, {
    intent: what.intent ?? undefined, scope: what.scope ?? undefined, request: what.request ?? undefined, summary: what.summary, biometric, slot,
  }, theme)
  return { ticket, url, address }
}

/** The wallet approved `ticket`: bind it (intent) or note the spend limit, and return the token. */
export async function finishWalletConfirm(address: string, ticket: string, what: { intent?: ConfirmIntent | null; scope?: ConfirmScope | null }): Promise<string> {
  if (what.intent) {
    const { bindConfirmation } = await import('@/wallet/account')
    bindConfirmation(address, what.intent, ticket)
  } else if (what.scope) {
    const { noteWalletApproved } = await import('./walletApproval')
    noteWalletApproved(address)
  }
  return issueWalletConfirmToken(ticket)
}

type Asset = ConfirmScope['limits'][number]['asset']
const ASSET_DECIMALS: Record<Asset, number> = { USDC: 6, EURC: 6, cirBTC: 8 }
/** Up to 5% over the screen's figure (rates move between quote and signing), plus `extra` (fees taken in the token). */
const SCOPE_MARGIN = 1.05
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * A spend limit for a screen's action: what may leave the wallet in the
 * next 2 minutes, per asset, and MeshPort contracts (not Circle's - the
 * wallet knows those) the action calls. Null when an amount isn't known.
 */
export function spendScope(limits: Array<{ asset: Asset; amount: number; extra?: number }>, contracts: Array<{ address?: string | null; label: string }> = []): ConfirmScope | null {
  const out: ConfirmScope['limits'] = []
  for (const l of limits) {
    if (!(l.asset in ASSET_DECIMALS) || !Number.isFinite(l.amount) || l.amount < 0) return null
    const d = ASSET_DECIMALS[l.asset]
    // Rounded up to the token's smallest unit, after dropping float noise (10 × 1.05 = 10.500000000000002).
    const v = Math.ceil(Number(((l.amount * SCOPE_MARGIN + Math.max(0, l.extra ?? 0)) * 10 ** d).toFixed(3))) / 10 ** d
    const s = v.toFixed(d)
    out.push({ asset: l.asset, amount: s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s })
  }
  if (!out.length) return null
  const seen = new Set<string>()
  const named = contracts
    .filter(c => !!c.address && ADDRESS.test(c.address) && !seen.has(c.address.toLowerCase()) && !!seen.add(c.address.toLowerCase()))
    .map(c => ({ address: c.address!, label: c.label }))
  return { limits: out, contracts: named.length ? named : undefined }
}

// Read straight from the env (as the escrow and router modules do) so a
// screen's passcode step doesn't load the wallet library.
const P2P_ESCROW = String((import.meta.env.VITE_P2P_ESCROW_CONTRACT as string | undefined) ?? '').trim()

/** A P2P step: `amount` USDC may go into escrow (0 for a cancel, release, edit), calls to the escrow contract. */
export function p2pScope(amount: number): ConfirmScope | null {
  return spendScope([{ asset: 'USDC', amount }], [{ address: P2P_ESCROW, label: 'MeshPort P2P escrow' }])
}

/** A cross-chain send of `amount` (+ up to `fee` taken in the token on the way), through MeshPort's routers where configured. */
export function bridgeScope(asset: Asset, amount: number, fee: number): ConfirmScope | null {
  const arc = String((import.meta.env.VITE_ARC_ROUTER as string | undefined) ?? '').trim()
  const routers = [arc, ...Object.values(routerAddressesRaw())].map(address => ({ address, label: 'MeshPort router' }))
  return spendScope([{ asset, amount, extra: fee }], routers)
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

/**
 * Loads the wallet's confirm page once, hidden, so its code, styles and font
 * are cached before the first payment: the passcode step then opens at once
 * instead of waiting on downloads. Without a ticket the page only says the
 * link expired; nothing is started or signed. Once per app run.
 */
let prewarmed = false
export function prewarmWalletConfirm(theme: 'dark' | 'light'): void {
  if (prewarmed || typeof document === 'undefined' || !walletConfirmAddress()) return
  prewarmed = true
  void import('@/wallet').then(({ walletOrigin }) => {
    const f = document.createElement('iframe')
    f.src = `${walletOrigin()}/confirm.html#theme=${theme}`
    f.title = ''
    f.tabIndex = -1
    f.setAttribute('aria-hidden', 'true')
    f.setAttribute('referrerpolicy', 'no-referrer')
    // Laid out (so the font is fetched too) but out of sight and untouchable.
    Object.assign(f.style, { position: 'fixed', left: '-10000px', top: '0', width: '320px', height: '120px', border: '0', visibility: 'hidden', pointerEvents: 'none' })
    const drop = () => setTimeout(() => f.remove(), 3000)
    f.addEventListener('load', drop, { once: true })
    setTimeout(() => f.remove(), 20_000) // never left behind
    document.body.appendChild(f)
  }).catch(() => { prewarmed = false })
}
