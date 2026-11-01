import { describe, it, expect, vi } from 'vitest'
import { waitForUbCredit, ubBalanceShort } from './ubClaim'

const kitWith = (...confirmed: number[]) => {
  let i = 0
  return {
    unifiedBalance: {
      getBalances: vi.fn(async () => {
        const c = confirmed[Math.min(i++, confirmed.length - 1)]
        return { breakdown: [{ breakdown: [{ chain: 'Arc_Testnet', confirmedBalance: String(c), pendingBalance: '0' }] }] }
      }),
    },
  }
}

describe('Gateway counts a deposit a moment after Arc confirms it (field 1 Nov 14:53)', () => {
  it('the refusal is recognised', () => {
    expect(ubBalanceShort(new Error('Insufficient USDC balance on Arc Testnet. Available: 0.015218 USDC, required: 0.99915 USDC'))).toBe(true)
    expect(ubBalanceShort(new Error('Insufficient total maxFee across intents to cover forwarding fee'))).toBe(false)
  })
  it('already counted: answers at once', async () => {
    const kit = kitWith(1.015)
    expect(await waitForUbCredit(kit, '0xa', 0.99915, 1_000, 10)).toBe(true)
    expect(kit.unifiedBalance.getBalances).toHaveBeenCalledTimes(1)
  })
  it('waits until it shows', async () => {
    const kit = kitWith(0.015218, 0.015218, 1.015218)
    expect(await waitForUbCredit(kit, '0xa', 0.99915, 1_000, 10)).toBe(true)
    expect(kit.unifiedBalance.getBalances).toHaveBeenCalledTimes(3)
  })
  it('gives up after the timeout', async () => {
    expect(await waitForUbCredit(kitWith(0.015218), '0xa', 0.99915, 50, 10)).toBe(false)
  })
})
