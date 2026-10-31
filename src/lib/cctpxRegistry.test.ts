import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const EURC_ID = '0x2587821a0ee7daa174b95436b5dab1731cfa1844775b010217d3c0dd02a4eecd'
const row = (id: string, deployments: Array<{ domainId: number; tokenAddress: string; enabled?: boolean }>) => ({ tokenId: id, deployments })
const ARC = { domainId: 26, tokenAddress: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a' }
const BASE = { domainId: 6, tokenAddress: '0x808456652fdb597867f38412077a9182bf77359f' }
const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body })

describe('bridge-relay CCTPx registry lookup', () => {
  let urls: string[]
  beforeEach(() => { vi.resetModules(); urls = [] })
  afterEach(() => { vi.unstubAllGlobals() })

  it('asks Circle for the one token (not the whole ~1,000-token registry) and caches it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { urls.push(u); return json({ data: [row(EURC_ID, [ARC, BASE])] }) }))
    const { cctpxTokenAddress } = await import('../../api/bridge-relay')
    expect(await cctpxTokenAddress('EURC', 6)).toBe(BASE.tokenAddress)
    expect(await cctpxTokenAddress('EURC', 6)).toBe(BASE.tokenAddress)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain(`/v2/cctpx/tokens?tokenId=${EURC_ID}`)
  })

  it('is null when the token is off on either end', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [row(EURC_ID, [ARC, { ...BASE, enabled: false }])] })))
    const { cctpxTokenAddress } = await import('../../api/bridge-relay')
    expect(await cctpxTokenAddress('EURC', 6)).toBeNull()
  })

  it('falls back to walking the registry (200 a page) when the filter finds nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      urls.push(u)
      if (u.includes('tokenId=')) return json({ data: [] })
      if (u.includes('pageAfter=')) return json({ data: [row(EURC_ID, [ARC, BASE])], nextPageAfter: null })
      return json({ data: [row('0xother', [])], nextPageAfter: 'cursor-1' })
    }))
    const { cctpxTokenAddress } = await import('../../api/bridge-relay')
    expect(await cctpxTokenAddress('EURC', 6)).toBe(BASE.tokenAddress)
    expect(urls.some(u => u.includes('pageSize=200'))).toBe(true)
  })
})
