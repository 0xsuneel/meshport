// ── Payments stuck on Arc behind a missing nonce ────────────────────────────
// Arc runs a wallet's transactions strictly in nonce order. A payment sent
// with nonce N while nonce N-1 was never used waits in the nodes' queues -
// and runs, together with every later one, the moment N-1 is used (live,
// 28 Oct: nonce 10 never sent, payments 11-14 queued).
//
// Cancelling them: the same wallet signs a 0 USDC transfer to itself for each
// queued nonce, with a higher fee, so the nodes replace the queued payment
// with it; then one for the missing nonce, which lets them all run. Only the
// self-transfers can then land - the payments' nonces are used. Costs network
// fees only. The server's recovery (payNonceRecovery) then marks each payment
// REPLACED: its nonce went to a transaction to a different address.

import { keccak256, parseGwei } from 'viem'
import type { WalletAccount } from '@/wallet'
import { arcRpcJson } from './arc'
import { ARC_CHAIN_INLINE } from './arcService'

export interface StuckPayments {
  /** The wallet's next nonce on Arc (nothing queued counts). */
  chainNonce: number
  /** Sent payments queued above it. */
  stuck: { nonce: number; txHash: string }[]
}

/** This wallet's payments queued on Arc behind a missing nonce, or null if it can't tell. */
export async function fetchStuckPayments(): Promise<StuckPayments | null> {
  try {
    const { invokeLinked } = await import('./supabase')
    const { data, error } = await invokeLinked('pay-intent', { action: 'stuckPayments' })
    if (error || !data?.success || typeof data.chainNonce !== 'number' || !Array.isArray(data.stuck)) return null
    return { chainNonce: data.chainNonce, stuck: data.stuck }
  } catch { return null }
}

export type CancelOutcome = 'cancelled' | 'ran' | 'unknown'

// Well above the payments' own caps (25 gwei, tip 1 gwei): a node only swaps a
// queued transaction for one paying clearly more.
const MAX_FEE = parseGwei('60')
const TIP = parseGwei('20')
const RELAY = 'meshport_sendRawTransactionAndWait'

async function receipt(hash: string): Promise<{ status: string } | null> {
  try { return (await arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }))?.result ?? null } catch { return null }
}

/**
 * Cancels `s.stuck` (see the file comment). Resolves with what happened to
 * each queued payment, read from Arc: 'cancelled' (the self-transfer took its
 * nonce), 'ran' (the payment itself went through), 'unknown'.
 */
export async function cancelStuckPayments(
  account: WalletAccount,
  s: StuckPayments,
  onStep?: (text: string) => void,
): Promise<Record<number, CancelOutcome>> {
  if (!s.stuck.length) return {}
  const self = account.address
  const last = Math.max(...s.stuck.map(p => p.nonce))
  let gas = 30_000n
  try {
    const est = await arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_estimateGas', params: [{ from: self, to: self, value: '0x0' }] })
    gas = (BigInt(est.result) * 130n) / 100n
  } catch { /* the default covers a plain transfer */ }

  onStep?.('Signing')
  const signed: { nonce: number; raw: `0x${string}`; hash: `0x${string}` }[] = []
  for (let nonce = s.chainNonce; nonce <= last; nonce++) {
    const raw = await account.signTransaction({
      type: 'eip1559', chainId: ARC_CHAIN_INLINE.id, to: self, value: 0n, gas, nonce,
      maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: TIP,
    })
    signed.push({ nonce, raw, hash: keccak256(raw) })
  }

  // Replacements first, to every node (the relay sends to all of them; a 1 ms
  // wait - 0 means its default 8 s, and a queued one has no receipt to wait for) -
  // twice, so a node that missed the first send still gets it. Only then the
  // missing nonce, which lets the queue run.
  onStep?.('Replacing the stuck payments')
  const replacements = signed.filter(t => t.nonce > s.chainNonce)
  for (let round = 0; round < 2; round++) {
    for (const t of replacements) {
      try { await arcRpcJson({ jsonrpc: '2.0', id: 1, method: RELAY, params: [t.raw, t.hash, 1] }, 20_000) } catch { /* checked on Arc below */ }
    }
  }
  onStep?.('Confirming on Arc')
  const gap = signed[0]
  try { await arcRpcJson({ jsonrpc: '2.0', id: 1, method: RELAY, params: [gap.raw, gap.hash, 8000] }, 20_000) } catch { /* checked below */ }

  // What actually took each queued payment's nonce.
  const out: Record<number, CancelOutcome> = {}
  const deadline = Date.now() + 20_000
  for (const p of s.stuck) {
    const mine = signed.find(t => t.nonce === p.nonce)!
    let result: CancelOutcome = 'unknown'
    while (Date.now() < deadline) {
      if (await receipt(mine.hash)) { result = 'cancelled'; break }
      if (await receipt(p.txHash)) { result = 'ran'; break }
      await new Promise(r => setTimeout(r, 500))
    }
    out[p.nonce] = result
  }
  return out
}
