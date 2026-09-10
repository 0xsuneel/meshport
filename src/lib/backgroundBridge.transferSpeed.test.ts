import { describe, it, expect } from 'vitest'
import { cctpSpeedForSource, STANDARD_ONLY_CCTP_SOURCES } from './backgroundBridge'

// Regression guard for the claim-direction bridge failing on Standard-only
// source chains. Per Arc's docs (app-kit/tutorials/bridge/pay-fees-on-source):
// Avalanche, Polygon PoS, Sei, XDC and their testnets support ONLY CCTP
// Standard Transfer. Passing transferSpeed 'FAST' (the SDK default) on those
// routes fails the Circle Quote API with PRE_FINALITY_UNAVAILABLE (HTTP 422)
// BEFORE the burn — which is what landed those claims on "Claim Failed".
describe('cctpSpeedForSource', () => {
  it('returns SLOW for Standard-only source chains (internal id)', () => {
    expect(cctpSpeedForSource('Avalanche_Fuji')).toBe('SLOW')
    expect(cctpSpeedForSource('Polygon_Sepolia')).toBe('SLOW')
    expect(cctpSpeedForSource('Sei_Testnet')).toBe('SLOW')
    expect(cctpSpeedForSource('XDC_Apothem')).toBe('SLOW')
  })

  it('returns SLOW when only the Circle SDK chain id matches (e.g. Polygon)', () => {
    // Internally Polygon is Polygon_Sepolia; the SDK id is Polygon_Amoy_Testnet.
    expect(cctpSpeedForSource('Polygon_Sepolia', 'Polygon_Amoy_Testnet')).toBe('SLOW')
    // Even if some caller passed a non-matching internal id, the SDK id wins.
    expect(cctpSpeedForSource('something_else', 'Avalanche_Fuji')).toBe('SLOW')
  })

  it('returns FAST for fast-finality source chains', () => {
    expect(cctpSpeedForSource('Ethereum_Sepolia')).toBe('FAST')
    expect(cctpSpeedForSource('Base_Sepolia')).toBe('FAST')
    expect(cctpSpeedForSource('Arbitrum_Sepolia')).toBe('FAST')
    expect(cctpSpeedForSource('Optimism_Sepolia')).toBe('FAST')
    expect(cctpSpeedForSource('Unichain_Sepolia')).toBe('FAST')
  })

  it('defaults to FAST for unknown chains rather than throwing', () => {
    expect(cctpSpeedForSource('Totally_New_Chain')).toBe('FAST')
    expect(cctpSpeedForSource('')).toBe('FAST')
  })

  it('keeps both Polygon aliases in the Standard-only set', () => {
    expect(STANDARD_ONLY_CCTP_SOURCES.has('Polygon_Sepolia')).toBe(true)
    expect(STANDARD_ONLY_CCTP_SOURCES.has('Polygon_Amoy_Testnet')).toBe(true)
  })
})
