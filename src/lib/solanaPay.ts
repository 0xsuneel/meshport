// src/lib/solanaPay.ts
//
// Paying a MeshPort request on Solana (docs/SOLANA.md) with Solana Pay - the
// QR / link format Phantom, Solflare and Backpack read:
//   solana:<recipient>?amount=<USDC>&spl-token=<USDC mint>&reference=<key>&label=…&message=…
// The reference is a key derived from the order code; the payer's wallet puts
// it in the transfer, so the payment names its order. merchant-pay derives the
// same key (supabase/functions/merchant-pay: solanaReference) - keep in step.

import { SOLANA_CHAIN, SOLANA_RPC, SOLANA_USDC_MINT } from './solana'

export const SOLANA_PAY_OPTION = { id: SOLANA_CHAIN, label: 'Solana', logo: '/logos/chains/solana.svg' } as const

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = []
  for (const byte of bytes) {
    let carry = byte
    for (let k = 0; k < digits.length; k++) { carry += digits[k] << 8; digits[k] = carry % 58; carry = (carry / 58) | 0 }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0 }
  }
  let out = ''
  for (const b of bytes) { if (b !== 0) break; out += '1' }
  for (let k = digits.length - 1; k >= 0; k--) out += B58[digits[k]]
  return out
}

/** The order's Solana Pay reference: base58(sha256("meshport-pay-ref:" + code)). */
export async function solanaReference(code: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('meshport-pay-ref:' + code.toLowerCase()))
  return base58Encode(new Uint8Array(h))
}

/** Solana Pay transfer request for USDC. */
export function solanaPayUri(p: { to: string; amount?: number; reference?: string; label?: string; message?: string }): string {
  const q = new URLSearchParams()
  if (p.amount && p.amount > 0) q.set('amount', p.amount.toFixed(6).replace(/\.?0+$/, ''))
  q.set('spl-token', SOLANA_USDC_MINT)
  if (p.reference) q.set('reference', p.reference)
  if (p.label) q.set('label', p.label)
  if (p.message) q.set('message', p.message)
  return `solana:${p.to}?${q.toString()}`
}

/** The newest successful Solana transaction that carries this reference, or null. */
export async function findSolanaPayment(reference: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const r = await fetchImpl(SOLANA_RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [reference, { limit: 5, commitment: 'confirmed' }] }),
    signal: AbortSignal.timeout(10_000),
  })
  const j = await r.json().catch(() => null) as { result?: Array<{ signature: string; err: unknown }> } | null
  const hit = (j?.result ?? []).find(s => !s.err && s.signature)
  return hit?.signature ?? null
}
