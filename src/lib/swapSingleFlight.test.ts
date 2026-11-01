// A swap the screen stopped waiting for (60 s timeout) may still broadcast:
// no second swap may start until it has really settled.
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/accountLockRule', () => ({ assertAccountUnlocked: () => {} }))
vi.mock('./perfTrace', () => ({ reportSwap: () => {} }))

describe('swap single-flight', () => {
  it('a second swap is refused while the first is in flight, and allowed once it settles', async () => {
    const mod = await import('./swapService')
    const params = { signer: { address: '0x1' } as any, walletAddress: '0x1', tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '1', slippageBps: 300 }
    const first = mod.executeSwapLocal(params as any).catch(e => e) // in flight (no SDK here: it fails later)
    await expect(mod.executeSwapLocal(params as any)).rejects.toBeInstanceOf(mod.SwapBusyError)
    expect(await first).not.toBeInstanceOf(mod.SwapBusyError)
    // Settled: the lock is free again.
    expect(await mod.executeSwapLocal(params as any).catch(e => e)).not.toBeInstanceOf(mod.SwapBusyError)
  })
})
