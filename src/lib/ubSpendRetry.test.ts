// Field 1 Nov (Recover → Send to Base): Gateway refused the signed spend -
// "Insufficient total maxFee across intents to cover forwarding fee. Required
// additional: 0.000181" - its forwarding fee moved between the estimate the SDK
// signed and the transfer. Nothing was sent; a fresh spend() re-estimates.
import { describe, it, expect, vi } from 'vitest'
vi.mock('./supabase', () => ({ supabase: {}, authApiHeaders: async () => ({}) }))
const { ubSpend, gatewayMaxFeeTooLow } = await import('./ubClaim')

const refusal = () => new Error('Gateway API error: HTTP 400 - — Insufficient total maxFee across intents to cover forwarding fee. Required additional: 0.000181')

describe('ubSpend', () => {
  it("Gateway's forwarding-fee refusal: asked again, succeeds on the fresh estimate", async () => {
    const spend = vi.fn().mockRejectedValueOnce(refusal()).mockResolvedValue({ txHash: '0xok' })
    const r = await ubSpend({ unifiedBalance: { spend } }, { amount: '1' })
    expect(r.txHash).toBe('0xok')
    expect(spend).toHaveBeenCalledTimes(2)
  })
  it('any other error is not retried', async () => {
    const spend = vi.fn().mockRejectedValue(new Error('Insufficient USDC balance on Arc Testnet'))
    await expect(ubSpend({ unifiedBalance: { spend } }, {})).rejects.toThrow(/Insufficient USDC balance/)
    expect(spend).toHaveBeenCalledTimes(1)
  })
  it('gives up after 3 tries', async () => {
    const spend = vi.fn().mockRejectedValue(refusal())
    await expect(ubSpend({ unifiedBalance: { spend } }, {}, 3)).rejects.toThrow(/maxFee/)
    expect(spend).toHaveBeenCalledTimes(3)
  }, 10_000)
  it('recognises the refusal in the error cause too', () => {
    expect(gatewayMaxFeeTooLow({ message: 'Gateway API error', cause: { trace: { message: 'Insufficient total maxFee across intents to cover forwarding fee' } } })).toBe(true)
    expect(gatewayMaxFeeTooLow(new Error('nonce too low'))).toBe(false)
  })
})
