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
