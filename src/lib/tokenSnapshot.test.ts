import { describe, it, expect } from 'vitest'
import { notePortfolio, peekTokenSnapshot } from './tokenSnapshot'
import { tokenChains } from '../../api/portfolio'
import { CHAINS as RELAYER_CHAINS } from '../../api/bridge-relay'
import { CCTP_DOMAINS } from '@/blockchain/chains'

const EURC_ID = '0x2587821a0ee7daa174b95436b5dab1731cfa1844775b010217d3c0dd02a4eecd'

describe('api/portfolio tokenChains', () => {
  const reg = (deployments: Array<{ domainId: number; tokenAddress: string; enabled?: boolean }>) => [{ tokenId: EURC_ID, deployments }]
  const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), C = '0x' + '3'.repeat(40)

  it('maps Circle domains to chain ids, skipping switched-off ones and Arc itself', () => {
    expect(tokenChains(reg([
      { domainId: 26, tokenAddress: A },
      { domainId: 0, tokenAddress: B },
      { domainId: 6, tokenAddress: C, enabled: false },
      { domainId: 999, tokenAddress: C },
    ]), EURC_ID)).toEqual({ Ethereum_Sepolia: B })
  })

  it('no route without the token on Arc', () => {
    expect(tokenChains(reg([{ domainId: 0, tokenAddress: B }]), EURC_ID)).toEqual({})
  })
})

describe('CCTP_DOMAINS', () => {
  it('matches the relayer’s domain for every chain it bridges', () => {
    for (const [id, c] of Object.entries(RELAYER_CHAINS)) expect(CCTP_DOMAINS[id], id).toBe(c.domain)
  })
})

describe('tokenSnapshot', () => {
  it('keeps Arc and per-chain EURC / cirBTC from a /api/portfolio answer', () => {
    notePortfolio('0xAbC', {
      arc: { USDC: 5, EURC: 2.5, cirBTC: 0.0001 },
      chains: { Ethereum_Sepolia: 1 },
      tokens: { EURC: { Ethereum_Sepolia: { balance: 3, address: '0xe' } }, cirBTC: {} },
    })
    const s = peekTokenSnapshot('0xabc')!
    expect(s.arc).toEqual({ EURC: 2.5, cirBTC: 0.0001 })
    expect(s.tokens?.EURC.Ethereum_Sepolia).toEqual({ balance: 3, address: '0xe' })
  })

  it('an answer without tokens keeps the last known chains', () => {
    notePortfolio('0xdef', { arc: {}, tokens: { EURC: { Base_Sepolia: { balance: 1, address: '0xb' } }, cirBTC: {} } })
    notePortfolio('0xdef', { arc: { EURC: 1 }, chains: {} })
    expect(peekTokenSnapshot('0xDEF')?.tokens?.EURC.Base_Sepolia.balance).toBe(1)
  })
})
