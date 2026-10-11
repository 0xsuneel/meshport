import { describe, it, expect } from 'vitest'
import { claimFeeSummary } from './claimFees'

describe('Bring Funds fees', () => {
  it('before arrival: MeshPort fee charged, Circle fee only "up to" its cap', () => {
    const s = claimFeeSummary({ base: { meshport: 0.05, circleCap: 0.12 } }, [{ sourceChain: 'base', amount: 9.95, arrivedAmount: null, status: 'bridging' }])
    expect(s).toEqual({ meshport: 0.05, circle: 0, circleCap: 0.12, final: false })
  })

  it('after arrival: Circle fee is what was really taken (burned − arrived), not the cap', () => {
    const s = claimFeeSummary({ base: { meshport: 0.05, circleCap: 0.12 } }, [{ sourceChain: 'base', amount: 9.95, arrivedAmount: 9.87, status: 'completed' }])
    expect(s.final).toBe(true)
    expect(s.circle).toBeCloseTo(0.08, 9)
    expect(s.circleCap).toBe(0)
  })

  it('several chains: arrived ones final, the rest still capped', () => {
    const s = claimFeeSummary(
      { base: { meshport: 0.05, circleCap: 0.1 }, eth: { meshport: 0.1, circleCap: 0.2 } },
      [{ sourceChain: 'base', amount: 5, arrivedAmount: 4.94, status: 'completed' }, { sourceChain: 'eth', amount: 5, arrivedAmount: null, status: 'bridging' }],
    )
    expect(s.meshport).toBeCloseTo(0.15, 9)
    expect(s.circle).toBeCloseTo(0.06, 9)
    expect(s.circleCap).toBe(0.2)
    expect(s.final).toBe(false)
  })
})
