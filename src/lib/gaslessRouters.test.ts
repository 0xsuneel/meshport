import { describe, it, expect } from 'vitest'
import { NO_SIGNING_DOMAIN, hasGaslessRouter } from './gaslessRouters'

describe('chains with no signing domain', () => {
  it('lists Linea Sepolia, whose test USDC has no DOMAIN_SEPARATOR', () => {
    expect(NO_SIGNING_DOMAIN.has('Linea_Sepolia')).toBe(true)
  })
  it('never reports a gasless router there', () => {
    expect(hasGaslessRouter('Linea_Sepolia')).toBe(false)
  })
})
