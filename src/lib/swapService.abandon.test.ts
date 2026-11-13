// A swap the screen stopped waiting for (its 60 s are up) must never go
// through later: Circle's SDK call can't be cancelled, so its provider is
// switched off (abandonSwap) - and the screen says "nothing was swapped" only
// when the swap transaction really never went out.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Transaction, Wallet } from 'ethers'

vi.mock('@/lib/accountLockRule', () => ({ assertAccountUnlocked: () => {} }))
vi.mock('./perfTrace', () => ({ reportSwap: () => {} }))
vi.mock('@/lib/supabase', () => ({ supabase: {}, authApiHeaders: async () => ({}) }))
vi.mock('./arcService', () => ({ USDC_CONTRACT: '0x3600000000000000000000000000000000000000', EURC_CONTRACT: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', CIRBTC_CONTRACT: '0x0000000000000000000000000000000000000001' }))
vi.mock('./chainExplorers', () => ({ ARC_EXPLORER: 'https://explorer' }))
vi.mock('./arc', () => ({ ARC_NETWORK: { chainId: 5042002, name: 'arc' }, arcRpcJson: async () => ({ result: null }), isDirectReadable: () => false }))
// What reached the network: every signed transaction the relay was handed.
const relayed: string[] = []
vi.mock('./arcRelaySend', () => ({ relayRawSend: async (req: { id: unknown; params: string[] }) => { relayed.push(req.params[0]); return { jsonrpc: '2.0', id: req.id, result: Transaction.from(req.params[0]).hash } } }))
vi.mock('@circle-fin/adapter-ethers-v6', () => ({}))
vi.mock('@/wallet', () => ({ createWalletAdapter: async (o: { getProvider: () => unknown }) => ({ getProvider: o.getProvider }) }))

// Circle's kit, stood in for by: approve → (wait) → swap, each sent through
// the provider the swap was given - exactly where the real one sends.
let gate: Promise<void> = Promise.resolve()
const signer = new Wallet('0x' + '11'.repeat(32))
const signed = (data: string, nonce: number) => signer.signTransaction({ type: 2, chainId: 5042002, nonce, to: '0x' + '22'.repeat(20), data, gasLimit: 100000, maxFeePerGas: 1, maxPriorityFeePerGas: 1 })
vi.mock('@circle-fin/app-kit', () => ({
  isKitError: () => false, isRpcError: () => false, isNetworkError: () => false,
  AppKit: class {
    async swap(p: { from: { adapter: { getProvider: () => { _send(x: unknown): Promise<{ result?: string; error?: { message: string } }[]> } } } }) {
      const provider = p.from.adapter.getProvider()
      const send = async (raw: string) => {
        const [r] = await provider._send({ id: 1, jsonrpc: '2.0', method: 'eth_sendRawTransaction', params: [raw] })
        if (r.error) throw new Error(r.error.message)
        return r.result!
      }
      await send(await signed('0x095ea7b3' + '00'.repeat(64), 0)) // the approval
      await gate                                                   // ...its receipt never comes
      return { txHash: await send(await signed('0xdeadbeef', 1)), amountOut: '0.9' }
    }
  },
}))
vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({}) }))

const params = { signer: { address: signer.address } as never, walletAddress: signer.address, tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '1', slippageBps: 500 }

describe('abandonSwap', () => {
  beforeEach(() => { relayed.length = 0 })

  it('nothing running: nothing to stop', async () => {
    const { abandonSwap } = await import('./swapService')
    expect(abandonSwap()).toBe('not-sent')
  })

  it('stopped before the swap transaction went out: it can never be sent, and another swap may start', async () => {
    const { executeSwapLocal, abandonSwap, SwapBusyError } = await import('./swapService')
    let open!: () => void
    gate = new Promise<void>(r => { open = r })
    const first = executeSwapLocal(params)
    const firstEnd = first.then(() => 'swapped', (e: Error & { isUncertain?: boolean }) => ({ message: e.message, isUncertain: e.isUncertain }))
    await vi.waitFor(() => expect(relayed.length).toBe(1)) // the approval went out
    await expect(executeSwapLocal(params)).rejects.toBeInstanceOf(SwapBusyError) // still one at a time

    expect(abandonSwap()).toBe('not-sent')
    open() // the SDK call wakes up and tries to send the swap
    expect(await firstEnd).toEqual({ message: "The swap didn't go through - nothing was swapped. Please try again.", isUncertain: false })
    // Only the approval ever reached the network - never the swap.
    expect(relayed.length).toBe(1)
    expect(Transaction.from(relayed[0]).data.startsWith('0x095ea7b3')).toBe(true)

    // And the next swap is not blocked by the stopped one.
    gate = Promise.resolve()
    const second = await executeSwapLocal(params)
    expect(second.txHash).toMatch(/^0x/)
    expect(relayed.length).toBe(3)
  })

  it('the swap transaction already went out: not stopped - its result is read from Arc', async () => {
    const { executeSwapLocal, abandonSwap } = await import('./swapService')
    gate = Promise.resolve()
    const run = executeSwapLocal(params)
    await vi.waitFor(() => expect(relayed.length).toBe(2))
    expect(abandonSwap()).toBe('sent')
    expect((await run).txHash).toMatch(/^0x/)
  })
})
