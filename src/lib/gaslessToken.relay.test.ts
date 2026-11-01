// Field 1 Nov 04:46: EURC from Ethereum - the phone lost the relayer's answer
// ("Failed to fetch" after 40 s) and showed "Claim Failed" for a transfer
// that may have been sent. The same signed request is now asked again, and an
// answer that never comes is "unknown" (watched on Arc), never "failed".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./gaslessBridge', () => ({ gaslessRouter: () => '0x5FbDB2315678afecb367f032d93F642f64180aa3' }))
vi.mock('@/lib/accountLockRule', () => ({ assertAccountUnlocked: () => {} }))
vi.mock('@/lib/supabase', () => ({ authApiHeaders: async () => ({ 'Content-Type': 'application/json' }) }))

import { bringTokenGasless, TokenBringUnknown, forgetTokenQuotes, CCTPX_TOKEN_IDS } from './gaslessToken'

const ME = '0x1111111111111111111111111111111111111111'
const EURC = '0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4'
const quote = { fee: '300000', nativeFee: '1', finality: 2000, token: EURC, tokenId: CCTPX_TOKEN_IDS.EURC, decimals: 6, auth: '3009', domainName: 'EURC', domainVersion: '2' }
const signer = { address: ME, signTypedData: vi.fn(async () => '0x' + '11'.repeat(65)) } as any
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as any
const run = () => bringTokenGasless({ chainId: 'Base_Sepolia', token: 'EURC', amount: 5, tokenAddress: EURC, signer, walletAddress: ME })

describe('token_relay answer lost', () => {
  beforeEach(() => { vi.useFakeTimers(); forgetTokenQuotes() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  function stub(relay: Array<() => any>) {
    const bodies: string[] = []
    const f = vi.fn(async (url: string, init?: any) => {
      if (url.includes('token_quote')) return json(200, quote)
      bodies.push(init.body)
      const next = relay.shift()!
      return next()
    })
    vi.stubGlobal('fetch', f)
    return bodies
  }

  it('asks again with the same signed request; the relayer answers with the transfer it already sent', async () => {
    const bodies = stub([() => { throw new TypeError('Failed to fetch') }, () => json(200, { txHash: '0x' + 'aa'.repeat(32), alreadySubmitted: true })])
    const p = run()
    await vi.runAllTimersAsync()
    const r = await p
    expect(r.txHash).toBe('0x' + 'aa'.repeat(32))
    expect(r.receive).toBeCloseTo(4.7)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toBe(bodies[0]) // identical signatures - usable once on-chain
  })

  it('no answer at all: unknown (watched), never failed', async () => {
    stub(Array.from({ length: 4 }, () => () => { throw new TypeError('Failed to fetch') }))
    const p = run().catch(e => e)
    await vi.runAllTimersAsync()
    const e = await p
    expect(e).toBeInstanceOf(TokenBringUnknown)
    expect(e.sentUnknown).toBe(true)
    expect(e.receive).toBeCloseTo(4.7)
  })

  it('a retry that only adds a failed duplicate is unknown, not failed', async () => {
    stub([() => { throw new TypeError('Failed to fetch') }, () => json(502, { error: 'Transaction reverted', txHash: '0x' + 'bb'.repeat(32) })])
    const p = run().catch(e => e)
    await vi.runAllTimersAsync()
    expect(await p).toBeInstanceOf(TokenBringUnknown)
  })

  it('a real refusal on the first answer is still an error (nothing was sent)', async () => {
    stub([() => json(400, { error: 'Not enough EURC on this chain' })])
    const p = run().catch(e => e)
    await vi.runAllTimersAsync()
    const e = await p
    expect(e).not.toBeInstanceOf(TokenBringUnknown)
    expect(e.message).toMatch(/Not enough EURC/)
  })
})
