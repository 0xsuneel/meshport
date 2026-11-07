// What each money screen asks the wallet frame to approve, in exact terms
// (docs/SECURE-APPROVALS.md). Upper bounds in base units: the Express move
// that follows must fit inside (same token, recipient, chain; at most this
// amount). Light on purpose: screens import it synchronously.
import type { ApprovalIntent, Hex } from '@/wallet/protocol'
import { CCTP_DOMAINS } from './cctpTracker'
import { EXTERNAL_CHAINS } from '@/blockchain/chains'

const ARC_TOKENS: Record<string, { address: Hex; decimals: number }> = {
  USDC: { address: '0x3600000000000000000000000000000000000000', decimals: 6 },
  EURC: { address: '0x89b50855aa3be2f677cd6303cec089b5f319d72a', decimals: 6 },
  cirBTC: { address: '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf', decimals: 8 },
}
const isAddr = (a: unknown): a is Hex => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)
// The same rounding Express uses (fastPay atomic(), gaslessBridge toUnits()).
const units = (amount: number, decimals: number) => String(BigInt(Math.round(amount * 10 ** decimals)))
const ok = (amount: number) => Number.isFinite(amount) && amount > 0

// The intent of the passcode sheet just completed: lib/fastPay hands it to the
// wallet frame with that passcode. One use, and only for a minute.
let noted: { intent: ApprovalIntent; at: number } | null = null
export function noteApprovalIntent(intent: ApprovalIntent | undefined): void {
  noted = intent ? { intent, at: Date.now() } : null
}
export function takeApprovalIntent(): ApprovalIntent | undefined {
  const n = noted
  noted = null
  return n && Date.now() - n.at < 60_000 ? n.intent : undefined
}

/** A payment on Arc of `amount` `token` to `to`. */
export function payIntent(token: string, to: string | null | undefined, amount: number): ApprovalIntent | undefined {
  const t = ARC_TOKENS[token]
  return t && isAddr(to) && ok(amount) ? { kind: 'pay', token: t.address, to, amount: units(amount, t.decimals) } : undefined
}

/** A USDC transfer from Arc to `recipient` on chain `chainKey`. */
export function transferIntent(chainKey: string, recipient: string | null | undefined, amountUsdc: number): ApprovalIntent | undefined {
  const domain = CCTP_DOMAINS[chainKey]
  return domain !== undefined && isAddr(recipient) && ok(amountUsdc)
    ? { kind: 'transfer', amount: units(amountUsdc, 6), destinationDomain: domain, recipient } : undefined
}

/** A swap on Arc of up to `amount` `tokenIn`. */
export function swapIntent(tokenIn: string, amount: number): ApprovalIntent | undefined {
  const t = ARC_TOKENS[tokenIn]
  return t && ok(amount) ? { kind: 'swap', tokenIn: t.address, amount: units(amount, t.decimals) } : undefined
}

/** A USDC Bring of up to `amountUsdc` from chain `chainKey` to the wallet's own Arc address. */
export function bringIntent(chainKey: string | null | undefined, amountUsdc: number): ApprovalIntent | undefined {
  const id = chainKey ? EXTERNAL_CHAINS[chainKey]?.chainId : undefined
  return typeof id === 'number' && ok(amountUsdc) ? { kind: 'bring', chainId: id, amount: units(amountUsdc, 6) } : undefined
}
