import { describe, it, expect, vi } from 'vitest'

// MeshPort's swap fee through Circle's customFee (lib/swapService swapCustomFee).
const WALLET = '0x9999999999999999999999999999999999999999'
vi.stubEnv('VITE_FEE_WALLET', WALLET)
vi.mock('./eurcPrice', () => ({ lastKnownEurcPrice: () => 1.08 }))
vi.mock('./btcPrice', () => ({ lastKnownBtcPrice: () => 100_000 }))
const { swapCustomFee } = await import('./swapService')

describe('swap fee: 0.35%, cap $10, to the relayer wallet', () => {
  it('under the cap: 35 bps', async () => {
    expect(await swapCustomFee('USDC', 'EURC', '100')).toEqual({ percentageBps: 35, recipientAddress: WALLET })
  })
  it('over the cap: exactly $10, in the output token', async () => {
    expect(await swapCustomFee('USDC', 'EURC', '5000')).toEqual({ amount: String(Math.floor(10 / 1.08 * 1e6)), recipientAddress: WALLET })
    expect(await swapCustomFee('USDC', 'cirBTC', '5000')).toEqual({ amount: '10000', recipientAddress: WALLET }) // $10 at $100k = 0.0001 BTC
  })
})
