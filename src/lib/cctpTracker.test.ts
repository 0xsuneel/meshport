import { describe, it, expect, vi, afterEach } from 'vitest'
import { progressFromIris, CCTP_DOMAINS, fetchCctpProgress, IRIS, IRIS_SANDBOX } from './cctpTracker'

describe('progressFromIris - CCTP progress read from Circle', () => {
  it('no Iris record yet → still burning', () => {
    expect(progressFromIris(null).stage).toBe('burning')
  })
  it('pending confirmations → attesting, with Circle’s delay reason', () => {
    const p = progressFromIris({ status: 'pending_confirmations', attestation: 'PENDING', delayReason: 'insufficient_fee' })
    expect(p).toEqual({ stage: 'attesting', delayReason: 'insufficient_fee' })
  })
  it('attested but not yet forwarded → minting', () => {
    expect(progressFromIris({ status: 'complete', attestation: '0xabc', forwardState: 'PENDING' }).stage).toBe('minting')
  })
  it('forwarder minted → done with the mint tx', () => {
    expect(progressFromIris({ status: 'complete', attestation: '0xabc', forwardState: 'COMPLETE', forwardTxHash: '0xmint' }))
      .toEqual({ stage: 'done', mintTxHash: '0xmint' })
  })
  it('forwarding failed → error that says the funds are safe', () => {
    const p = progressFromIris({ status: 'complete', attestation: '0xabc', forwardState: 'FAILED' })
    expect(p.stage).toBe('error')
    expect(p.msg).toMatch(/safe/)
  })
  it('a mint already on record wins', () => {
    expect(progressFromIris({ status: 'pending_confirmations' }, '0xknown')).toEqual({ stage: 'done', mintTxHash: '0xknown' })
  })
  it('knows Arc and the source chains', () => {
    expect(CCTP_DOMAINS.Arc_Testnet).toBe(26)
    expect(CCTP_DOMAINS.Base_Sepolia).toBe(6)
    expect(CCTP_DOMAINS.Ethereum_Sepolia).toBe(0)
  })
})


describe('fetchCctpProgress - which Iris answers', () => {
  const HASH = '0x' + 'ab'.repeat(32)
  afterEach(() => { vi.unstubAllGlobals() })

  it('asks the sandbox Iris by default (testnet burns are only known there)', () => {
    expect(IRIS).toBe(IRIS_SANDBOX)
  })

  it('a burn the first Iris has no record of is looked up on the other one, not left on "burning"', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      urls.push(u)
      return u.startsWith(IRIS)
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ messages: [{ status: 'complete', attestation: '0xabc', forwardState: 'COMPLETE', forwardTxHash: '0xmint' }] }) }
    }))
    expect(await fetchCctpProgress('Base_Sepolia', HASH)).toEqual({ stage: 'done', mintTxHash: '0xmint' })
    expect(urls).toHaveLength(2)
  })

  it('no record anywhere yet → burning; Iris unreachable → unknown (null)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
    expect(await fetchCctpProgress('Base_Sepolia', HASH)).toEqual({ stage: 'burning' })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    expect(await fetchCctpProgress('Base_Sepolia', HASH)).toBeNull()
  })
})
