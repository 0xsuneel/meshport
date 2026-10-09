// /api/arc-rpc meshport_sendRawTransactionAndWait: broadcast to every Arc
// node at once, wait for the receipt server-side.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const RAW = '0x02abc0'
const HASH = '0x' + 'ab'.repeat(32)

type Node = (method: string) => any
function stub(node: Node) {
  const fn = vi.fn(async (_url: string, init: any) => {
    const { method, id } = JSON.parse(init.body)
    const out = node(method)
    if (out instanceof Error) throw out
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, ...out }), { status: 200 })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}
async function relay(params: unknown[]) {
  const mod: any = await import('../../api/arc-rpc.js')
  return mod.sendAndWait(1, params)
}

describe('meshport_sendRawTransactionAndWait', () => {
  beforeEach(() => { vi.resetModules(); vi.unstubAllGlobals() })

  it('sends to every node and returns the confirmed receipt', async () => {
    const fn = stub(m => m === 'eth_sendRawTransaction' ? { result: HASH } : { result: { status: '0x1', blockNumber: '0x2a' } })
    const r = await relay([RAW, HASH, 2000])
    expect(r.result).toMatchObject({ hash: HASH, status: 'success', blockNumber: '0x2a' })
    const sends = fn.mock.calls.filter(c => JSON.parse((c[1] as any).body).method === 'eth_sendRawTransaction')
    expect(sends.length).toBeGreaterThan(1) // every endpoint, not just one
  })

  it('does not wait for a slow node once another accepted', async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      const { method, id } = JSON.parse(init.body)
      if (method === 'eth_sendRawTransaction' && n++ === 0) await new Promise(r => setTimeout(r, 4000)) // first node hangs
      const out = method === 'eth_sendRawTransaction' ? { result: HASH } : { result: { status: '0x1', blockNumber: '0x1' } }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, ...out }), { status: 200 })
    }))
    const t0 = Date.now()
    const r = await relay([RAW, HASH, 2000])
    expect(r.result.status).toBe('success')
    expect(Date.now() - t0).toBeLessThan(1500)
  })

  it('a reverted receipt is failed', async () => {
    stub(m => m === 'eth_sendRawTransaction' ? { result: HASH } : { result: { status: '0x0', blockNumber: '0x2b' } })
    expect((await relay([RAW, HASH, 2000])).result.status).toBe('failed')
  })

  it('"already known" counts as sent; no receipt in time is pending', async () => {
    stub(m => m === 'eth_sendRawTransaction' ? { error: { code: -32000, message: 'already known' } } : { result: null })
    const r = await relay([RAW, HASH, 700])
    expect(r.result).toMatchObject({ status: 'pending', broadcast: 'sent' })
  })

  it('every node rejects: error -32003 (nothing sent)', async () => {
    stub(m => m === 'eth_sendRawTransaction' ? { error: { code: -32000, message: 'insufficient funds for gas * price + value' } } : { result: null })
    const r = await relay([RAW, HASH, 700])
    expect(r.error.code).toBe(-32003)
    expect(r.error.message).toMatch(/insufficient funds/)
  })

  it('no node reachable: pending/unknown (the phone keeps watching), bad input rejected', async () => {
    stub(() => new TypeError('fetch failed'))
    expect((await relay([RAW, HASH, 300])).result).toMatchObject({ status: 'pending', broadcast: 'unknown' })
    expect((await relay(['nothex', HASH])).error.code).toBe(-32602)
    expect((await relay([RAW, '0x12'])).error.code).toBe(-32602)
  })
})
