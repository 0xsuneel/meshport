import { describe, it, expect } from 'vitest'
import { deploymentsFromRegistry, routeChains, KIT_CCTPX_CHAINS, type RegistryToken } from './tokenBridge'

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

describe('World Chain (EURC)', () => {
  it('is a route when Circle lists EURC there, but not a kit chain (Bring through the router only)', () => {
    const dep = new Map([['Arc_Testnet', '0xa'], ['World_Chain_Sepolia', '0xw']])
    expect(routeChains(dep)).toEqual(['World_Chain_Sepolia'])
    expect(KIT_CCTPX_CHAINS.has('World_Chain_Sepolia')).toBe(false)
  })
})

describe('direct registry lookup', () => {
  it('asks Circle for one token by id and parses its row', async () => {
    const { fetchTokenRow, CCTPX_REGISTRY_IDS, staticRouteDomains } = await import('./tokenBridge')
    const urls: string[] = []
    const fetchImpl = (async (u: string) => {
      urls.push(u)
      return { ok: true, json: async () => ({ data: [{ tokenId: CCTPX_REGISTRY_IDS.EURC.toUpperCase().replace('0X', '0x'), deployments: [{ domainId: 26, tokenAddress: '0xarc' }, { domainId: 6, tokenAddress: '0xbase' }] }] }) }
    }) as unknown as typeof fetch
    const row = await fetchTokenRow('EURC', fetchImpl)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain(`/v2/cctpx/tokens?tokenId=${CCTPX_REGISTRY_IDS.EURC}`)
    const dep = deploymentsFromRegistry([row], 'EURC', () => 'EURC', staticRouteDomains())
    expect([...dep.keys()].sort()).toEqual(['Arc_Testnet', 'Base_Sepolia'])
  })

  it('throws when the registry does not list the token', async () => {
    const { fetchTokenRow } = await import('./tokenBridge')
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ data: [] }) })) as unknown as typeof fetch
    await expect(fetchTokenRow('cirBTC', fetchImpl)).rejects.toThrow()
  })

  it('uses the same token ids as the gasless bring', async () => {
    const { CCTPX_REGISTRY_IDS } = await import('./tokenBridge')
    const { CCTPX_TOKEN_IDS } = await import('./gaslessToken')
    expect(CCTPX_REGISTRY_IDS).toEqual(CCTPX_TOKEN_IDS)
  })

  it('covers every route chain with a CCTP domain', async () => {
    const { staticRouteDomains } = await import('./tokenBridge')
    const d = staticRouteDomains()
    expect(Object.keys(d).sort()).toEqual(Object.keys(CCTPX_CHAIN_DEFS_FOR_TEST).sort())
    expect(d.Arc_Testnet).toBe(26)
  })
})

const CCTPX_CHAIN_DEFS_FOR_TEST = {
  Arc_Testnet: 1, Ethereum_Sepolia: 1, Base_Sepolia: 1, Arbitrum_Sepolia: 1, Optimism_Sepolia: 1,
  Avalanche_Fuji: 1, Polygon_Amoy_Testnet: 1, World_Chain_Sepolia: 1,
}
