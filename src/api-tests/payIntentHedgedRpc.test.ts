import { describe, it, expect } from 'vitest'
import { hedgedRpc } from '../../supabase/functions/pay-intent/hedgedRpc'

// pay-intent's nonce read (supabase/functions/pay-intent/hedgedRpc.ts):
// a slow or failing node must not hold the payment.
type Node = { delay: number; status?: number; result?: string; error?: unknown }
function fakeFetch(nodes: Record<string, Node>, calls: string[]) {
  return (async (url: string, init: RequestInit) => {
    calls.push(url)
    const n = nodes[url]
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, n.delay)
      init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) })
    })
    return new Response(JSON.stringify(n.error ? { error: n.error } : { result: n.result }), { status: n.status ?? 200 })
  }) as unknown as typeof fetch
}

describe('pay-intent hedged nonce read', () => {
  it('a fast first node answers alone', async () => {
    const calls: string[] = []
    const r = await hedgedRpc(['a', 'b'], 'eth_getTransactionCount', [], { fetch: fakeFetch({ a: { delay: 20, result: '0x5' }, b: { delay: 20, result: '0x5' } }, calls), hedgeMs: 100 })
    expect(r).toMatchObject({ result: '0x5', url: 'a' })
    expect(calls).toEqual(['a'])
  })

  it('a stalled first node: the next is asked after the hedge delay and wins - no 10 s wait', async () => {
    const calls: string[] = []
    const t0 = Date.now()
    const r = await hedgedRpc(['slow', 'fast'], 'm', [], { fetch: fakeFetch({ slow: { delay: 5000, result: '0x1' }, fast: { delay: 20, result: '0x7' } }, calls), hedgeMs: 100, nodeTimeoutMs: 3000 })
    expect(r).toMatchObject({ result: '0x7', url: 'fast' })
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('a rate-limited node (429) moves on at once, without waiting for the hedge delay', async () => {
    const calls: string[] = []
    const t0 = Date.now()
    const r = await hedgedRpc(['limited', 'ok'], 'm', [], { fetch: fakeFetch({ limited: { delay: 10, status: 429 }, ok: { delay: 10, result: '0x2' } }, calls), hedgeMs: 1000 })
    expect(r.result).toBe('0x2')
    expect(Date.now() - t0).toBeLessThan(300)
  })

  it('every node fails: the last error', async () => {
    await expect(hedgedRpc(['a', 'b'], 'm', [], { fetch: fakeFetch({ a: { delay: 5, error: { message: 'bad' } }, b: { delay: 5, status: 500 } }, []), hedgeMs: 50 }))
      .rejects.toThrow('RPC 500 from b')
  })

  it('a node that never answers is cut off at its own timeout', async () => {
    await expect(hedgedRpc(['hang'], 'm', [], { fetch: fakeFetch({ hang: { delay: 10_000, result: '0x1' } }, []), nodeTimeoutMs: 100 }))
      .rejects.toThrow('aborted')
  })
})
