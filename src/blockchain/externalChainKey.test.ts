import { describe, it, expect } from 'vitest'
import { externalChainKey, EXTERNAL_CHAINS } from './chains'

describe('externalChainKey (indexer chain id -> EXTERNAL_CHAINS key)', () => {
  it('maps the indexer kebab-case ids onto the app keys', () => {
    expect(externalChainKey('ethereum-sepolia')).toBe('Ethereum_Sepolia')
    expect(externalChainKey('world-chain-sepolia')).toBe('World_Chain_Sepolia')
    expect(externalChainKey('hyperevm-testnet')).toBe('HyperEVM_Testnet')
    expect(externalChainKey('polygon-amoy')).toBe('Polygon_Sepolia')
  })
  it('leaves app keys and Arc unchanged', () => {
    expect(externalChainKey('Base_Sepolia')).toBe('Base_Sepolia')
    expect(externalChainKey('arc')).toBe('arc')
  })
  it('every indexer external chain resolves to a known key', () => {
    const ids = ['ethereum-sepolia', 'base-sepolia', 'arbitrum-sepolia', 'optimism-sepolia', 'polygon-amoy', 'avalanche-fuji',
      'hyperevm-testnet', 'sei-testnet', 'sonic-testnet', 'unichain-sepolia', 'world-chain-sepolia', 'linea-sepolia', 'ink-testnet',
      'monad-testnet', 'morph-testnet', 'pharos-testnet', 'plume-testnet', 'xdc-apothem', 'codex-testnet', 'edge-testnet', 'injective-testnet']
    for (const id of ids) expect(EXTERNAL_CHAINS[externalChainKey(id)], id).toBeDefined()
  })
})
