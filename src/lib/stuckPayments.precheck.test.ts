// Stuck-payment check (docs/SUPABASE_LIGHT_PLAN.md, Phase 3): ask Arc's node
// first; only when transactions are queued does it cost a pay-intent call.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key')
const invokeLinked = vi.fn(async () => ({ data: { success: true, chainNonce: 5, stuck: [{ nonce: 6, txHash: '0xabc' }] }, error: null }))
vi.mock('./supabase', () => ({ invokeLinked }))

let m: typeof import('./stuckPayments')
beforeEach(async () => { m = await import('./stuckPayments'); invokeLinked.mockClear() })
afterEach(() => { vi.unstubAllGlobals() })

function arcAnswers(latest: string, pending: string) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [{ id: 2, result: pending }, { id: 1, result: latest }] })))
}

describe('stuck payments pre-check', () => {
  it('hasQueuedTransactions compares pending to latest', () => {
    expect(m.hasQueuedTransactions('0x5', '0x5')).toBe(false)
    expect(m.hasQueuedTransactions('0x5', '0x7')).toBe(true)
    expect(m.hasQueuedTransactions(undefined, '0x7')).toBeNull()
    expect(m.hasQueuedTransactions('zz', '0x7')).toBeNull()
  })

  it('nothing queued on Arc: no server call', async () => {
    arcAnswers('0x5', '0x5')
    const s = await m.fetchStuckPayments('0xWallet')
    expect(s?.stuck).toEqual([])
    expect(invokeLinked).not.toHaveBeenCalled()
  })

  it('something queued: the server lists it', async () => {
    arcAnswers('0x5', '0x7')
    const s = await m.fetchStuckPayments('0xWallet')
    expect(invokeLinked).toHaveBeenCalledTimes(1)
    expect(s?.stuck).toHaveLength(1)
  })

  it('Arc unreachable: falls back to the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await m.fetchStuckPayments('0xWallet')
    expect(invokeLinked).toHaveBeenCalledTimes(1)
  })
})
