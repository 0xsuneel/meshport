import { describe, it, expect, vi, beforeEach } from 'vitest'

const W = '0x4cb2ff6492d51edfb54f0cff3b517d7f207d80a1'
const store: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v },
  removeItem: (k: string) => { delete store[k] },
})
let writeOk = false
const swap = vi.fn(async () => writeOk)
vi.mock('./ActivityService', () => ({ Activity: { swap: (...a: unknown[]) => (swap as any)(...a) } }))
vi.mock('./arc', () => ({ arcRpcJson: async () => ({ result: null }) }))
vi.mock('./swapService', () => ({ amountOutFromReceipt: () => '' }))

import { enqueueSwapActivity, flushSwapActivityOutbox } from './swapActivityOutbox'

const queued = () => JSON.parse(store.meshport_swap_outbox_v1 || '[]')

describe('swap activity outbox', () => {
  beforeEach(() => { for (const k of Object.keys(store)) delete store[k]; swap.mockClear() })

  it('keeps a swap row that failed to write and retries it later', async () => {
    enqueueSwapActivity({ walletAddress: W, txHash: '0xAB', amountIn: 5, amountOut: 4.6, tokenIn: 'USDC', tokenOut: 'EURC' })
    writeOk = false
    await flushSwapActivityOutbox(W)
    expect(queued()).toHaveLength(1)
    expect(queued()[0].attempts).toBe(1)
    writeOk = true
    await flushSwapActivityOutbox(W)
    expect(queued()).toHaveLength(0)
    expect(swap).toHaveBeenCalledTimes(2)
  })

  it('queues one row per transaction and keeps the real amount', () => {
    enqueueSwapActivity({ walletAddress: W, txHash: '0xab', amountIn: 5, amountOut: 0, tokenIn: 'USDC', tokenOut: 'EURC' })
    enqueueSwapActivity({ walletAddress: W, txHash: '0xAB', amountIn: 5, amountOut: 4.6, tokenIn: 'USDC', tokenOut: 'EURC' })
    expect(queued()).toHaveLength(1)
    expect(queued()[0].amountOut).toBe(4.6)
  })
})
