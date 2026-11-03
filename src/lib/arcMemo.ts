// Arc transaction memos: an order payment carries its order on-chain.
// The USDC transfer is wrapped in Memo.memo(target, data, memoId, memo);
// the CallFrom precompile keeps the payer as the sender of the transfer.
// https://docs.arc.io/arc/concepts/transaction-memos
import { encodeFunctionData, erc20Abi, parseUnits, stringToHex, type Hex } from 'viem'

export const ARC_MEMO_CONTRACT = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505'
const ARC_USDC_ERC20 = '0x3600000000000000000000000000000000000000'
const MEMO_ABI = [{
  type: 'function', name: 'memo', stateMutability: 'nonpayable', outputs: [],
  inputs: [{ name: 'target', type: 'address' }, { name: 'data', type: 'bytes' }, { name: 'memoId', type: 'bytes32' }, { name: 'memoData', type: 'bytes' }],
}] as const

// ── MeshPortCheckout (contracts/MeshPortCheckout.sol) ───────────────────────
// When deployed (VITE_MESHPORT_CHECKOUT), an order payment goes through it
// instead of the Memo contract: the customer pays the full price, the contract
// sends the merchant the price minus MeshPort's merchant fee (0.6%, cap $3 -
// computed by the contract itself) and the fee to MeshPort's relayer wallet,
// in the same transaction. The order reference is the same as a memo's
// (orderMemoId) and is read back from the contract's Paid event by
// merchant-pay.
const CHECKOUT_ABI = [{
  type: 'function', name: 'pay', stateMutability: 'payable', outputs: [],
  inputs: [{ name: 'merchant', type: 'address' }, { name: 'orderRef', type: 'bytes32' }],
}] as const
export function checkoutAddress(): Hex | null {
  const a = String((import.meta.env.VITE_MESHPORT_CHECKOUT as string | undefined) ?? '').trim()
  return /^0x[0-9a-fA-F]{40}$/.test(a) ? a as Hex : null
}
/** Calldata for MeshPortCheckout.pay(merchant, orderRef) - the price is the transaction's value. */
export function checkoutPayData(merchant: string, memo: { code: string }): Hex {
  return encodeFunctionData({ abi: CHECKOUT_ABI, functionName: 'pay', args: [merchant as Hex, orderMemoId(memo.code)] })
}

/** What an order payment attaches: the order's code (memoId) and its number (memo text). */
export type OrderMemo = { code: string; label: string }

/** memoId for an order: its code as bytes32 (merchant-pay's watcher reads it back the same way). */
export function orderMemoId(code: string): Hex {
  return stringToHex(code.toLowerCase(), { size: 32 })
}

/** Calldata for the Memo contract: a USDC transfer of `amount` to `to`, with the order attached. */
export function memoTransferData(to: string, amount: number, memo: OrderMemo): Hex {
  const transfer = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to as Hex, parseUnits(amount.toFixed(6), 6)] })
  return encodeFunctionData({
    abi: MEMO_ABI, functionName: 'memo',
    args: [ARC_USDC_ERC20, transfer, orderMemoId(memo.code), stringToHex(`MeshPort ${memo.label}`)],
  })
}
