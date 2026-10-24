// server/mpc/requests.ts
//
// What MeshPort agrees to co-sign, and the hash it signs. The client sends
// the thing to sign - never a bare hash - and the server hashes it here, so it
// knows (and logs) what each signature is for:
//
//   { kind: 'tx', tx: <unsigned serialized transaction> }
//   { kind: 'message', message: string | { raw: hex } }
//   { kind: 'typed', typedData: { domain, types, primaryType, message } }
//
// TESTNET ONLY: transactions and typed data must name a known testnet.

import { hashMessage, hashTypedData, keccak256, parseTransaction, type Hex } from 'viem'
import { MpcServiceError } from './service'

/** Arc testnet, and the testnets MeshPort bridges with. */
export const TESTNET_CHAIN_IDS: ReadonlySet<number> = new Set([5042002, 11155111, 84532, 421614, 11155420, 43113, 80002])

export interface SignRequestHash { hash: Hex; kind: 'tx' | 'message' | 'typed'; summary: Record<string, unknown> }

const bad = (m: string): never => { throw new MpcServiceError('bad-request', m) }

export function hashSignRequest(request: unknown): SignRequestHash {
  const r = (request ?? {}) as Record<string, any>

  if (r.kind === 'tx') {
    if (typeof r.tx !== 'string' || !/^0x[0-9a-fA-F]+$/.test(r.tx)) bad('tx must be a serialized transaction')
    let tx: ReturnType<typeof parseTransaction>
    try { tx = parseTransaction(r.tx as Hex) } catch { return bad('tx is not a valid transaction') }
    if (tx.r || tx.s) bad('Send the unsigned transaction')
    if (!tx.chainId || !TESTNET_CHAIN_IDS.has(tx.chainId)) bad('MPC wallet signs testnet transactions only')
    return {
      hash: keccak256(r.tx as Hex),
      kind: 'tx',
      summary: {
        chainId: tx.chainId, to: tx.to ?? null, value: String(tx.value ?? 0n),
        nonce: tx.nonce ?? null, selector: tx.data && tx.data.length >= 10 ? tx.data.slice(0, 10) : null,
      },
    }
  }

  if (r.kind === 'message') {
    const m = r.message
    const raw = m && typeof m === 'object' && typeof m.raw === 'string' && /^0x[0-9a-fA-F]*$/.test(m.raw)
    if (typeof m !== 'string' && !raw) bad('message must be text or { raw: hex }')
    return { hash: hashMessage(m), kind: 'message', summary: { bytes: typeof m === 'string' ? new TextEncoder().encode(m).length : (m.raw.length - 2) / 2 } }
  }

  if (r.kind === 'typed') {
    const t = r.typedData
    const chainId = Number(t?.domain?.chainId)
    if (!TESTNET_CHAIN_IDS.has(chainId)) bad('MPC wallet signs testnet typed data only')
    let hash: Hex
    try { hash = hashTypedData(t) } catch { return bad('typedData is not valid EIP-712 data') }
    return { hash, kind: 'typed', summary: { chainId, primaryType: t.primaryType, verifyingContract: t.domain?.verifyingContract ?? null } }
  }

  return bad('Unknown request kind')
}
