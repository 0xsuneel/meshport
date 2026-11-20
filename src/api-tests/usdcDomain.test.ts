import { describe, it, expect } from 'vitest'
import { matchUsdcDomain, usdcDomainSeparator } from '../../api/_lib/usdcDomain'

const TOKEN = '0xFEce4462D57bD51A6A552365A011b95f0E16d9B7' as const

describe('matchUsdcDomain', () => {
  it('keeps what the token reports when it matches its separator', () => {
    const sep = usdcDomainSeparator('USDC', '2', 59141, TOKEN)
    expect(matchUsdcDomain(sep, 59141, TOKEN, { name: 'USDC', version: '2' })).toEqual({ name: 'USDC', version: '2' })
  })
  it('finds the real name when name() differs from the signing domain', () => {
    const sep = usdcDomainSeparator('USD Coin', '2', 59141, TOKEN)
    expect(matchUsdcDomain(sep, 59141, TOKEN, { name: 'USDC', version: '2' })).toEqual({ name: 'USD Coin', version: '2' })
  })
  it('finds the real version too', () => {
    const sep = usdcDomainSeparator('USDC', '1', 59141, TOKEN)
    expect(matchUsdcDomain(sep, 59141, TOKEN, { name: 'USDC', version: '2' })).toEqual({ name: 'USDC', version: '1' })
  })
  it('returns null when nothing matches (wrong chain id, say)', () => {
    const sep = usdcDomainSeparator('USDC', '2', 1, TOKEN)
    expect(matchUsdcDomain(sep, 59141, TOKEN, { name: 'USDC', version: '2' })).toBeNull()
  })
})
