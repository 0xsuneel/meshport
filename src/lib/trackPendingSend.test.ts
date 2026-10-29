import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

let receipt: any = null
let tx: any = { hash: '0xabc' }
let count = '0x5'
vi.mock('./arc', () => ({
  ARC_RPCS: [], ARC_TESTNET: { explorerUrl: '' },
  arcRpcJson: async (b: any) => ({
    result: b.method === 'eth_getTransactionReceipt' ? receipt : b.method === 'eth_getTransactionByHash' ? tx : count,
  }),
}))
vi.mock('@/wallet', () => ({}))

describe('trackPendingSend', () => {
  beforeEach(() => { vi.useFakeTimers(); receipt = null; tx = { hash: '0xabc' }; count = '0x5' })
  afterEach(() => vi.useRealTimers())

  it('reports success when the receipt lands', async () => {
    const { trackPendingSend } = await import('./arcService')
    const out = vi.fn()
    trackPendingSend('0xabc', { sender: '0x1', nonce: 5 }, out)
    receipt = { status: '0x1' }
    await vi.advanceTimersByTimeAsync(2100)
    expect(out).toHaveBeenCalledWith('success')
  })

  it('keeps waiting while the transaction is queued behind a stuck one', async () => {
    const { trackPendingSend } = await import('./arcService')
    const out = vi.fn()
    trackPendingSend('0xabc', { sender: '0x1', nonce: 5, maxMs: 60_000 }, out)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(out).not.toHaveBeenCalled()
  })

  it("reports replaced when the transaction is gone and the wallet's nonce moved past it", async () => {
    const { trackPendingSend } = await import('./arcService')
    const out = vi.fn()
    tx = null; count = '0x6'
    trackPendingSend('0xabc', { sender: '0x1', nonce: 5 }, out)
    await vi.advanceTimersByTimeAsync(25_000)
    expect(out).toHaveBeenCalledWith('replaced')
  })
})
