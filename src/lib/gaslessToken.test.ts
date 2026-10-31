import { describe, it, expect } from 'vitest'
import { tokenBridgeNonce, checkTokenQuote, CCTPX_TOKEN_IDS, type TokenQuote } from './gaslessToken'

describe('tokenBridgeNonce', () => {
  it('matches MeshPortRouter.tokenBridgeNonce (test/MeshPortRouter.tokens.test.js)', () => {
    expect(tokenBridgeNonce({
      token: '0x1111111111111111111111111111111111111111', tokenId: CCTPX_TOKEN_IDS.EURC, destinationDomain: 26,
      recipient: '0x2222222222222222222222222222222222222222', fee: 300000n, minFinalityThreshold: 1000,
      salt: `0x${'ab'.repeat(32)}`,
    }, 31337, '0x5FbDB2315678afecb367f032d93F642f64180aa3'))
      .toBe('0x7b5a933e299b687d3456f46cd911d7cd8d100082cfc093976bbcc83b7c99772d')
  })
})

describe('checkTokenQuote', () => {
  const addr = '0x1111111111111111111111111111111111111111'
  const q = (o: Partial<TokenQuote> = {}): TokenQuote => ({
    fee: '300000', nativeFee: '1', finality: 1000, token: addr, tokenId: CCTPX_TOKEN_IDS.EURC, decimals: 6,
    auth: '3009', domainName: 'EURC', domainVersion: '2', ...o,
  })
  it('accepts a normal quote', () => {
    expect(checkTokenQuote(q(), 'EURC', 100_000_000n, addr)).toBe(300000n)
  })
  it('refuses a token address that is not the one in Circle’s registry', () => {
    expect(() => checkTokenQuote(q(), 'EURC', 100_000_000n, '0x3333333333333333333333333333333333333333')).toThrow()
    expect(() => checkTokenQuote(q(), 'EURC', 100_000_000n, undefined)).toThrow()
  })
  it('refuses another token id', () => {
    expect(() => checkTokenQuote(q({ tokenId: CCTPX_TOKEN_IDS.cirBTC }), 'EURC', 100_000_000n, addr)).toThrow()
  })
  it('refuses a fee over 5% (above the small fixed allowance)', () => {
    expect(() => checkTokenQuote(q({ fee: '6000000' }), 'EURC', 100_000_000n, addr)).toThrow(/unusually high/)
    // 0.6 EURC is always allowed - but never the whole amount
    expect(checkTokenQuote(q({ fee: '600000' }), 'EURC', 2_000_000n, addr)).toBe(600000n)
    expect(() => checkTokenQuote(q({ fee: '600000' }), 'EURC', 600_000n, addr)).toThrow(/too small/)
  })
  it('refuses unknown auth or finality', () => {
    expect(() => checkTokenQuote(q({ auth: 'x' as any }), 'EURC', 100_000_000n, addr)).toThrow()
    expect(() => checkTokenQuote(q({ finality: 5 }), 'EURC', 100_000_000n, addr)).toThrow()
  })
})

describe('relayer fee in the token (api/bridge-relay tokenFeeUnits)', async () => {
  const { tokenFeeUnits } = await import('../../api/bridge-relay')
  it('prices gas + Circle’s native fee in EURC / cirBTC', () => {
    // 0.0001 ETH at $3000 = $0.30 → 0.30 / 1.1 EURC, 0.30 / 100000 cirBTC
    expect(tokenFeeUnits(100_000_000_000_000n, 3000, 'EURC', {})).toBe(272728n)
    expect(tokenFeeUnits(100_000_000_000_000n, 3000, 'cirBTC', {})).toBe(300n)
  })
  it('is capped (testnet gas priced at mainnet rates)', () => {
    expect(tokenFeeUnits(10n ** 18n, 3000, 'EURC', {})).toBe(454546n) // $0.50 cap / 1.1
    expect(tokenFeeUnits(10n ** 18n, 3000, 'EURC', { BRIDGE_TOKEN_MAX_FEE_USD: '0.2', BRIDGE_EURC_USD: '1' })).toBe(200000n)
  })
})
