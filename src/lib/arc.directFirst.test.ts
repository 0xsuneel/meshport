// Arc reads from the device, not through the Vercel proxy (MetaMask's model):
// arcTransport / arcRpcJson send plain reads to Circle's Arc node, keep sends
// and nonce reads on /api/arc-rpc, and answer eth_chainId locally.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPublicClient } from 'viem'

let arc: typeof import('./arc')
const urls: string[] = []
function mockFetch(answer: (url: string, body: any) => { status?: number; json: any }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(String(url))
    const body = JSON.parse(String(init?.body ?? '{}'))
    const a = answer(String(url), body)
    return { ok: (a.status ?? 200) < 400, status: a.status ?? 200, json: async () => a.json, text: async () => JSON.stringify(a.json) }
  }))
}
beforeEach(async () => { vi.resetModules(); urls.length = 0; arc = await import('./arc') })
afterEach(() => { vi.unstubAllGlobals() })

describe('Arc reads straight from the node', () => {
  it('eth_chainId is answered locally - no request', async () => {
    mockFetch(() => ({ json: {} }))
    const r = await arc.arcRpcJson({ jsonrpc: '2.0', id: 7, method: 'eth_chainId', params: [] })
    expect(r).toEqual({ jsonrpc: '2.0', id: 7, result: '0x' + (5042002).toString(16) })
    expect(urls).toHaveLength(0)
  })

  it('transfer-log reads are direct reads', () => {
    expect(arc.isDirectReadable({ method: 'eth_getLogs' })).toBe(true)
    expect(arc.isDirectReadable({ method: 'eth_getTransactionCount' })).toBe(false)
  })

  it('arcTransport: a read goes to Circle’s Arc node, a send to the proxy', async () => {
    mockFetch((_url, body) => ({ json: { jsonrpc: '2.0', id: body.id, result: body.method === 'eth_blockNumber' ? '0x10' : '0xabc' } }))
    const client = createPublicClient({ transport: arc.arcTransport() })
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(16n)
    expect(urls[0]).toBe('https://rpc.testnet.arc.io')
    await client.request({ method: 'eth_sendRawTransaction', params: ['0x01'] } as any)
    expect(urls[urls.length - 1]).toBe('/api/arc-rpc')
  })

  it('a direct read refused (rate limit) falls back to the proxy', async () => {
    mockFetch((url, body) => url === 'https://rpc.testnet.arc.io'
      ? { status: 429, json: {} }
      : { json: { jsonrpc: '2.0', id: body.id, result: '0x20' } })
    const r = await arc.arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{}] })
    expect(r.result).toBe('0x20')
    expect(urls).toEqual(['https://rpc.testnet.arc.io', '/api/arc-rpc'])
  })
})
