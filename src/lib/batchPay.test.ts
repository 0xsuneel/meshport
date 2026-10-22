// batchPay: one Multicall3 call pays everyone, with the exact amounts.
import { describe, it, expect, vi } from 'vitest'
import { decodeFunctionData, parseAbi } from 'viem'

vi.mock('@/lib/supabase', () => ({ resolveUsernameDb: vi.fn(), getUserByWalletAddress: vi.fn(), supabase: {} }))

import { buildBatch, batchFee } from './batchPay'

const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'

describe('buildBatch', () => {
  it('sends each person their amount (18-decimal native USDC) and totals the value', () => {
    const { totalValue, data } = buildBatch([{ walletAddress: A, amount: 520 }, { walletAddress: B, amount: 0.05 }])
    expect(totalValue).toBe(520_050_000_000_000_000_000n)
    const abi = parseAbi(['function aggregate3Value((address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])'])
    const { args } = decodeFunctionData({ abi, data })
    const calls = args[0] as ReadonlyArray<{ target: string; allowFailure: boolean; value: bigint }>
    expect(calls.map(c => [c.target.toLowerCase(), c.value, c.allowFailure])).toEqual([
      [A, 520_000_000_000_000_000_000n, false], [B, 50_000_000_000_000_000n, false],
    ])
  })
})

describe('batchFee', () => {
  it('is one flat transaction fee plus a little per person', () => {
    expect(batchFee(0)).toBe(0)
    expect(batchFee(4)).toBeCloseTo(0.0028)
  })
})
