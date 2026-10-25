// src/lib/solanaBridge.ts
//
// The Solana side of MeshPort's cross-chain moves (docs/SOLANA.md):
//   - bringSolanaToArc: burn the account's Solana USDC with Circle's
//     forwarding hook (lib/solanaCctp.ts); Circle mints it on Arc to the
//     account's own Arc address. MeshPort pays the SOL fee and rent.
//   - ensureSolanaUsdcAccount: before Arc → Solana, have MeshPort open the
//     recipient's USDC account if it has none (Circle's mint needs it).
// Both go through /api/solana-fee-payer.

import { getBase64Decoder } from '@solana/kit'
import { buildSolanaBurnToArc, quoteSolanaToArc } from './solanaCctp'

async function api<T>(body?: unknown): Promise<T> {
  const { authApiHeaders } = await import('@/lib/supabase')
  const r = await fetch('/api/solana-fee-payer', body === undefined
    ? { headers: await authApiHeaders() }
    : { method: 'POST', headers: { ...(await authApiHeaders()), 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({})) as T & { error?: string }
  if (!r.ok) throw new Error(j.error || `Solana request failed (${r.status})`)
  return j
}

let feePayer: Promise<string> | null = null
export function solanaFeePayer(): Promise<string> {
  if (!feePayer) {
    feePayer = api<{ feePayer: string }>().then(j => j.feePayer)
    feePayer.catch(() => { feePayer = null })
  }
  return feePayer
}

/** Make sure `owner` has a USDC account on Solana (MeshPort opens it if not). */
export async function ensureSolanaUsdcAccount(owner: string): Promise<{ account: string; created: boolean }> {
  return api({ openAccount: owner })
}

export interface SolanaBring {
  /** The burn's Solana transaction signature (track it with lib/cctpTracker). */
  signature: string
  /** USDC (base units) burned; Arc receives this minus Circle's fee. */
  amount: bigint
  maxFee: bigint
  confirmed: boolean
}

/** Circle's fees for bringing `amount` (base units) from Solana to Arc. */
export { quoteSolanaToArc }

/** Bring `amountUsdc` of the signed-in account's Solana USDC to its Arc address `arcAddress`. */
export async function bringAccountSolanaToArc(arcAddress: string, amountUsdc: number): Promise<SolanaBring> {
  const { getSolanaAddress, signSolanaTransaction } = await import('@/wallet/solana')
  const r = await bringSolanaToArc({ owner: await getSolanaAddress(), arcRecipient: arcAddress, amount: BigInt(Math.round(amountUsdc * 1e6)), sign: signSolanaTransaction })
  import('@/lib/ActivityService').then(({ Activity }) => Activity.bridge({
    walletAddress: arcAddress, txHash: r.signature, amount: amountUsdc,
    sourceChain: 'Solana_Devnet', destinationChain: 'Arc_Testnet', destinationAddress: arcAddress,
  })).catch(() => {})
  return r
}

/**
 * Bring `amount` (base units) of the account's Solana USDC to its Arc address.
 * `sign` signs the transaction as the account's Solana wallet (wallet/solana.ts).
 */
export async function bringSolanaToArc(p: {
  owner: string; arcRecipient: string; amount: bigint; sign: (wire: Uint8Array) => Promise<Uint8Array>
}): Promise<SolanaBring> {
  const [{ maxFee }, payer] = await Promise.all([quoteSolanaToArc(p.amount), solanaFeePayer()])
  const unsigned = await buildSolanaBurnToArc({ owner: p.owner, arcRecipient: p.arcRecipient, amount: p.amount, maxFee, feePayer: payer })
  const signed = await p.sign(unsigned)
  const transaction = getBase64Decoder().decode(signed)
  const r = await api<{ signature: string; confirmed: boolean }>({ transaction })
  return { signature: r.signature, amount: p.amount, maxFee, confirmed: r.confirmed }
}
