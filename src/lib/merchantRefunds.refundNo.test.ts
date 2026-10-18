import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/lib/arc', () => ({ arcTransport: () => ({}) }))
vi.mock('@/blockchain/chains', () => ({ ARC_CHAIN_INLINE: {}, circleForwarderMintsTo: () => false }))
vi.mock('@/lib/describeFunctionsError', () => ({ describeFunctionsError: async () => '' }))
vi.mock('@/lib/cctpTracker', () => ({ CCTP_DOMAINS: {} }))
vi.mock('@/lib/gaslessBridge', () => ({ FORWARD_HOOK: '0x', FAST_FINALITY: 1000, ARC_DOMAIN: 26 }))

import { nextRefundNo, refundRef, paymentRef, REFUNDS_CONTRACT } from './merchantRefunds'

const ID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427'
const MERCHANT = '0x1111111111111111111111111111111111111111'

describe('nextRefundNo', () => {
  it('refund 1 uses the payment reference (old refunds stay valid)', () => {
    expect(refundRef(ID, 1)).toBe(paymentRef(ID))
    expect(refundRef(ID, 2)).not.toBe(paymentRef(ID))
  })

  it('picks the first reference not used on the contract', async () => {
    const used = new Set([refundRef(ID, 1), refundRef(ID, 2)])
    const readContract = vi.fn(async (a: any) => {
      expect(a.address).toBe(REFUNDS_CONTRACT)
      expect(a.functionName).toBe('isRefunded')
      expect(a.args[0]).toBe(MERCHANT)
      return used.has(a.args[1])
    })
    expect(await nextRefundNo({ readContract }, MERCHANT, ID)).toBe(3)
    expect(readContract).toHaveBeenCalledTimes(3)
  })

  it('is 1 for a payment never refunded', async () => {
    expect(await nextRefundNo({ readContract: async () => false }, MERCHANT, ID)).toBe(1)
  })
})
