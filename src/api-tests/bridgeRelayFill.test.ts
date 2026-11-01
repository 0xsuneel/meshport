import { describe, it, expect, vi } from 'vitest'
import { createWalletClient, custom, defineChain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { withoutNodeFill } from '../../api/bridge-relay'

// Field 1 Nov 15:36: Avalanche Fuji's node filled the relayer's transaction
// with gas 11,445,952,253,021,861 and a 204 wei fee cap - refused everywhere.
describe("the relayer never takes gas / fees from the node's eth_fillTransaction", () => {
  it("viem estimates them itself instead", async () => {
    const calls: string[] = []
    const node = vi.fn(async ({ method }: { method: string }) => {
      calls.push(method)
      switch (method) {
        case 'eth_fillTransaction': return { raw: '0x', tx: { gas: '0x28aa086e284ea6', maxFeePerGas: '0xcc', maxPriorityFeePerGas: '0x96' } }
        case 'eth_chainId': return '0xa869'
        case 'eth_getTransactionCount': return '0x14'
        case 'eth_estimateGas': return '0x30d40'
        case 'eth_maxPriorityFeePerGas': return '0x3b9aca00'
        case 'eth_getBlockByNumber': return { baseFeePerGas: '0x5d21dba00', number: '0x1', hash: '0x' + '1'.repeat(64), transactions: [] }
        default: throw new Error('unexpected ' + method)
      }
    })
    const chain = defineChain({ id: 43113, name: 'Fuji', nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 }, rpcUrls: { default: { http: ['http://x'] } } })
    const wallet = createWalletClient({ chain, transport: withoutNodeFill(custom({ request: node })), account: privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`) })
    const req: any = await wallet.prepareTransactionRequest({ to: '0x10d0611b0a7cb0c8af4438154700a730f008b8cb', data: '0x0f68a778' })
    expect(calls).not.toContain('eth_fillTransaction')
    expect(req.gas).toBe(200_000n)
    expect(req.maxFeePerGas > 1_000_000_000n).toBe(true)
  })
})
