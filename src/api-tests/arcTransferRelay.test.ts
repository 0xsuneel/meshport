import { describe, it, expect } from 'vitest'
import { arcTransferDomains, CHAINS } from '../../api/bridge-relay'

// api/bridge-relay arc_transfer (Transfer USDC out of Arc through the router):
// only known CCTP destinations, never Arc itself.
describe('arc_transfer destinations', () => {
  it('every Bring chain\'s CCTP domain, never Arc (26)', () => {
    const d = arcTransferDomains()
    expect(d.has(26)).toBe(false)
    for (const c of Object.values(CHAINS)) if (c.domain !== 26) expect(d.has(c.domain)).toBe(true)
    expect(d.has(6)).toBe(true) // Base Sepolia
  })
})
