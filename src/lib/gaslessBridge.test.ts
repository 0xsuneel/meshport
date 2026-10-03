import { describe, it, expect, vi, afterEach } from 'vitest'
import { bridgeNonce, checkQuote, isGaslessBridgeAvailable, gaslessRouter, FORWARD_HOOK, ARC_DOMAIN, type BridgeParams } from './gaslessBridge'

// Vector produced by the real MeshPortBridgeRouter.bridgeNonce() on Hardhat
// (chainId 31337, router deployed at the first deployment address).
const VECTOR = {
  chainId: 31337,
  router: '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const,
  nonce: '0x49120d98e0ac57c50604137c2960e5558914d7aa59549b27ceb9e54788cb4be3',
}
const params: BridgeParams = {
  destinationDomain: ARC_DOMAIN,
  mintRecipient: '0x0000000000000000000000001111111111111111111111111111111111111111',
  fee: 50000n, maxFee: 123456n, minFinalityThreshold: 1000,
  hookData: FORWARD_HOOK, salt: `0x${'ab'.repeat(32)}`,
}

describe('gaslessBridge', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('computes exactly the nonce the router contract computes', () => {
    expect(bridgeNonce(params, VECTOR.chainId, VECTOR.router)).toBe(VECTOR.nonce)
  })

  it('any changed parameter gives a different nonce', () => {
    const base = bridgeNonce(params, VECTOR.chainId, VECTOR.router)
    expect(bridgeNonce({ ...params, fee: 50001n }, VECTOR.chainId, VECTOR.router)).not.toBe(base)
    expect(bridgeNonce(params, 1, VECTOR.router)).not.toBe(base)
    expect(bridgeNonce(params, VECTOR.chainId, '0x0000000000000000000000000000000000000009')).not.toBe(base)
  })

  it('checkQuote rejects fees above the app’s own limits', () => {
    const amount = 100_000_000n // 100 USDC
    expect(checkQuote({ fee: '50000', maxFee: '200000', usdcName: 'USDC', usdcVersion: '2' }, amount)).toEqual({ fee: 50000n, maxFee: 200000n })
    expect(() => checkQuote({ fee: '6000000', maxFee: '0', usdcName: '', usdcVersion: '' }, amount)).toThrow(/high/)   // > 5% / > 2 USDC
    expect(() => checkQuote({ fee: '0', maxFee: '3000000', usdcName: '', usdcVersion: '' }, amount)).toThrow(/high/)   // > 2%
    expect(() => checkQuote({ fee: '0', maxFee: '10', usdcName: '', usdcVersion: '' }, 10n)).toThrow()
  })

  it('stays off until a router is configured, and ignores bad entries', () => {
    vi.stubEnv('VITE_BRIDGE_ROUTERS', '')
    expect(isGaslessBridgeAvailable('Base_Sepolia')).toBe(false)
    vi.stubEnv('VITE_BRIDGE_ROUTERS', JSON.stringify({ Base_Sepolia: '0x5fbdb2315678afecb367f032d93f642f64180aa3', Unknown_Chain: '0x5FbDB2315678afecb367f032d93F642f64180aa3', Ethereum_Sepolia: 'nope' }))
    expect(gaslessRouter('Base_Sepolia')).toBe('0x5FbDB2315678afecb367f032d93F642f64180aa3')
    expect(isGaslessBridgeAvailable('Unknown_Chain')).toBe(false)
    expect(isGaslessBridgeAvailable('Ethereum_Sepolia')).toBe(false)
  })
})
