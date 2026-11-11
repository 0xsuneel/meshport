// wallet-frame/src/intent.ts
//
// What a confirmation shows and allows (protocol.ts ConfirmIntent). The frame
// reads the transaction itself - recipient, amount, token, order - from its
// own fields, never from the app's description, and signs a transaction
// under a confirmation only when it is that same transaction.
//
// Arc only for now: USDC is Arc's native coin (18 decimals), EURC / cirBTC
// and the 6-decimal USDC interface are ERC-20s, and an order payment goes
// through Arc's Memo contract or MeshPortCheckout (src/lib/arcMemo.ts).

import { decodeFunctionData, formatUnits, getAddress, hexToString, type Hex } from 'viem'
import type { ConfirmIntent } from '@/wallet/protocol'

export const ARC_CHAIN_ID = 5042002
/** The most a confirmation may allow in fees: 0.1 USDC (Arc's native coin). */
export const MAX_CONFIRM_FEE = 100_000_000_000_000_000n

const TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '0x3600000000000000000000000000000000000000': { symbol: 'USDC', decimals: 6 },
  '0x89b50855aa3be2f677cd6303cec089b5f319d72a': { symbol: 'EURC', decimals: 6 },
  '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf': { symbol: 'cirBTC', decimals: 8 },
}
const MEMO_CONTRACT = '0x5294e9927c3306dcbadb03fe70b92e01ccede505'

const TRANSFER_ABI = [{
  type: 'function', name: 'transfer', stateMutability: 'nonpayable', outputs: [{ name: '', type: 'bool' }],
  inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
}] as const
const MEMO_ABI = [{
  type: 'function', name: 'memo', stateMutability: 'nonpayable', outputs: [],
  inputs: [{ name: 'target', type: 'address' }, { name: 'data', type: 'bytes' }, { name: 'memoId', type: 'bytes32' }, { name: 'memoData', type: 'bytes' }],
}] as const
const CHECKOUT_ABI = [{
  type: 'function', name: 'pay', stateMutability: 'payable', outputs: [],
  inputs: [{ name: 'merchant', type: 'address' }, { name: 'orderRef', type: 'bytes32' }],
}] as const

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/
const MAX_UINT = 2n ** 256n - 1n

/** A request's intent, checked and normalised; throws with a short reason. */
export function parseIntent(raw: unknown): ConfirmIntent {
  const r = (raw ?? {}) as Record<string, unknown>
  if (Number(r.chainId) !== ARC_CHAIN_ID) throw new Error('Only Arc payments can be confirmed here')
  if (typeof r.to !== 'string' || !ADDRESS.test(r.to)) throw new Error('No recipient')
  if (typeof r.value !== 'string' || !DECIMAL.test(r.value) || BigInt(r.value) > MAX_UINT) throw new Error('Bad amount')
  const data = r.data == null ? '0x' : r.data
  if (typeof data !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){0,4096}$/.test(data)) throw new Error('Bad transaction data')
  if (typeof r.maxFee !== 'string' || !DECIMAL.test(r.maxFee)) throw new Error('Bad fee limit')
  const maxFee = BigInt(r.maxFee)
  if (maxFee <= 0n || maxFee > MAX_CONFIRM_FEE) throw new Error('Fee limit out of range')
  return { chainId: ARC_CHAIN_ID, to: getAddress(r.to), value: r.value, data: data.toLowerCase() as Hex, maxFee: r.maxFee }
}

export interface IntentView {
  /** "Send", "Pay order", "Contract call". */
  action: string
  amount: string
  token: string
  /** Who receives the money (the merchant for an order). */
  to: string
  rows: { label: string; value: string }[]
  /** Where the card's figures come from, when not "read from the transaction". */
  source?: string
  /** Shown in red above the passcode: something here isn't a plain payment. */
  warnings: string[]
}

const units = (v: bigint, decimals: number) => {
  const s = formatUnits(v, decimals)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}
/** Printable text only, short (order labels come from the transaction). */
const clean = (s: string) => s.replace(/[^\x20-\x7E]/g, '').trim().slice(0, 60)
const feeRow = (intent: ConfirmIntent) => ({ label: 'Network fee', value: `at most ${units(BigInt(intent.maxFee), 18)} USDC` })

/** What the transaction does, read from its own fields. */
export function describeIntent(intent: ConfirmIntent, opts: { checkout?: string | null } = {}): IntentView {
  const value = BigInt(intent.value)
  const to = intent.to.toLowerCase()
  const data = intent.data.toLowerCase() as Hex
  const unknown = (why: string): IntentView => ({
    action: 'Contract call', amount: units(value, 18), token: 'USDC', to: intent.to,
    rows: [{ label: 'Contract', value: intent.to }, { label: 'Data', value: `${(data.length - 2) / 2} bytes` }, feeRow(intent)],
    warnings: [why],
  })

  // Plain USDC send (Arc's native coin).
  if (data === '0x') return { action: 'Send', amount: units(value, 18), token: 'USDC', to: intent.to, rows: [feeRow(intent)], warnings: [] }

  const token = TOKENS[to]
  if (token) {
    try {
      const d = decodeFunctionData({ abi: TRANSFER_ABI, data })
      const [recipient, amount] = d.args
      const warnings = value > 0n ? [`Also sends ${units(value, 18)} USDC to the token contract`] : []
      return { action: 'Send', amount: units(amount, token.decimals), token: token.symbol, to: getAddress(recipient), rows: [feeRow(intent)], warnings }
    } catch { return unknown(`An unrecognised call to the ${token.symbol} contract`) }
  }

  if (to === MEMO_CONTRACT) {
    try {
      const { args: [target, inner, , memoData] } = decodeFunctionData({ abi: MEMO_ABI, data })
      const t = TOKENS[target.toLowerCase()]
      if (!t) return unknown('An order payment for an unknown token')
      const { args: [recipient, amount] } = decodeFunctionData({ abi: TRANSFER_ABI, data: inner })
      let label = ''
      try { label = clean(hexToString(memoData)).replace(/^MeshPort\s+/, '') } catch { /* not text */ }
      const rows = [...(label ? [{ label: 'Order', value: label }] : []), feeRow(intent)]
      const warnings = value > 0n ? [`Also sends ${units(value, 18)} USDC to the memo contract`] : []
      return { action: 'Pay order', amount: units(amount, t.decimals), token: t.symbol, to: getAddress(recipient), rows, warnings }
    } catch { return unknown('An unrecognised call to the memo contract') }
  }

  try {
    const { args: [merchant, orderRef] } = decodeFunctionData({ abi: CHECKOUT_ABI, data })
    const known = !!opts.checkout && opts.checkout.toLowerCase() === to
    let ref = ''
    try { ref = clean(hexToString(orderRef, { size: 32 }).replace(/\0+$/, '')) } catch { /* not text */ }
    const rows = [
      ...(ref ? [{ label: 'Order', value: ref }] : []),
      { label: 'Paid through', value: known ? 'MeshPort Checkout (fee included)' : intent.to },
      feeRow(intent),
    ]
    return {
      action: 'Pay order', amount: units(value, 18), token: 'USDC', to: getAddress(merchant), rows,
      warnings: known ? [] : ['Paid through a contract this wallet does not recognise'],
    }
  } catch { /* not a checkout payment */ }

  return unknown('Not a payment this wallet can read - only continue if you trust it')
}

const big = (v: unknown): bigint => (v == null ? 0n : BigInt(v as bigint | string | number))

/** `tx` is the transaction `intent` allows (nonce and gas free, fee capped). */
export function matchesIntent(intent: ConfirmIntent, tx: Record<string, unknown>): boolean {
  try {
    if (Number(tx.chainId) !== intent.chainId) return false
    if (typeof tx.to !== 'string' || tx.to.toLowerCase() !== intent.to.toLowerCase()) return false
    if (big(tx.value) !== BigInt(intent.value)) return false
    const data = tx.data == null ? '0x' : String(tx.data).toLowerCase()
    if (data !== intent.data.toLowerCase()) return false
    if (tx.authorizationList != null || tx.blobs != null || tx.blobVersionedHashes != null) return false
    if (tx.type != null && tx.type !== 'eip1559' && tx.type !== 'legacy' && tx.type !== 'eip2930') return false
    if (tx.gas == null) return false
    const price = big(tx.maxFeePerGas ?? tx.gasPrice)
    if (price <= 0n) return false
    return big(tx.gas) * price <= BigInt(intent.maxFee)
  } catch { return false }
}
