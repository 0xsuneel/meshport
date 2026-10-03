import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRequire } from 'module'
import { bridgeNonce, checkQuote, isGaslessBridgeAvailable, gaslessRouter, FORWARD_HOOK, ARC_DOMAIN, GASLESS_CHAINS, type BridgeParams } from './gaslessBridge'
import { CHAINS as RELAYER_CHAINS } from '../../api/bridge-relay'
import { CCTP_DOMAINS } from './cctpTracker'
const DEPLOY_CHAINS = createRequire(import.meta.url)('../../contracts/deploy-bridge-router-all.cjs').CHAINS as Record<string, { chainId: number; usdc: string }>

// Vector produced by the real MeshPortBridgeRouter.bridgeNonce() on Hardhat
// (chainId 31337, router deployed at the first deployment address).
const VECTOR = {
  chainId: 31337,
  router: '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const,
  nonce: '0x8e16d70441d38f5ce387d8bda5037331f8564aef520a39026a849f6164e05234',
}
const params: BridgeParams = {
  token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
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
    expect(bridgeNonce({ ...params, token: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' }, VECTOR.chainId, VECTOR.router)).not.toBe(base)
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

  it('app, relayer and deploy script cover the same chains with the same chain id, USDC and CCTP domain', () => {
    const keys = Object.keys(GASLESS_CHAINS).sort()
    expect(Object.keys(RELAYER_CHAINS).sort()).toEqual(keys)
    expect(Object.keys(DEPLOY_CHAINS).sort()).toEqual(keys)
    for (const k of keys) {
      const app = GASLESS_CHAINS[k]
      expect(RELAYER_CHAINS[k].id, k).toBe(app.chainId)
      expect(RELAYER_CHAINS[k].usdc.toLowerCase(), k).toBe(app.usdc.toLowerCase())
      expect(RELAYER_CHAINS[k].domain, k).toBe(CCTP_DOMAINS[k])
      expect(DEPLOY_CHAINS[k].chainId, k).toBe(app.chainId)
      expect(DEPLOY_CHAINS[k].usdc.toLowerCase(), k).toBe(app.usdc.toLowerCase())
    }
    expect(keys.length).toBeGreaterThanOrEqual(15)
  })
})
