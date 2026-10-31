import { describe, it, expect } from 'vitest'
import { deploymentsFromRegistry, routeChains, type RegistryToken } from './tokenBridge'

const domains = { Arc_Testnet: 26, Ethereum_Sepolia: 0, Base_Sepolia: 6, Avalanche_Fuji: 1 }
const symbolOf = (id: string) => ({ 'eurc-1': 'EURC', 'btc-1': 'cirBTC' } as Record<string, string>)[id]

describe('deploymentsFromRegistry', () => {
  it('keeps enabled deployments of the token on known chains only', () => {
    const tokens: RegistryToken[] = [
      { tokenId: 'eurc-1', deployments: [
        { domainId: 26, tokenAddress: '0xarc' },
        { domainId: 0, tokenAddress: '0xeth', enabled: true },
        { domainId: 6, tokenAddress: '0xbase', enabled: false },
        { domainId: 99, tokenAddress: '0xunknown' },
      ] },
      { tokenId: 'btc-1', deployments: [{ domainId: 1, tokenAddress: '0xbtc' }] },
    ]
    const dep = deploymentsFromRegistry(tokens, 'EURC', symbolOf, domains)
    expect([...dep.entries()]).toEqual([['Arc_Testnet', '0xarc'], ['Ethereum_Sepolia', '0xeth']])
  })
})

describe('routeChains', () => {
  it('needs the token on Arc', () => {
    expect(routeChains(new Map([['Ethereum_Sepolia', '0x1']]))).toEqual([])
  })
  it('lists the other CCTPx chains where the token is deployed', () => {
    const dep = new Map([['Arc_Testnet', '0xa'], ['Base_Sepolia', '0xb'], ['Solana_Devnet', '0xs']])
    expect(routeChains(dep)).toEqual(['Base_Sepolia'])
  })
})
