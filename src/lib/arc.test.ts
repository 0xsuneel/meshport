import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const BLOCK = { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }

describe('isDirectReadable', () => {
  it('serves plain reads, never sends, nonces or batches', async () => {
    const { isDirectReadable } = await import('./arc')
    expect(isDirectReadable(BLOCK)).toBe(true)
    expect(isDirectReadable({ method: 'eth_call' })).toBe(true)
    expect(isDirectReadable({ method: 'eth_sendRawTransaction' })).toBe(false)
    expect(isDirectReadable({ method: 'meshport_sendRawTransactionAndWait' })).toBe(false)
    expect(isDirectReadable({ method: 'eth_getTransactionCount' })).toBe(false)
    expect(isDirectReadable([BLOCK])).toBe(false)
    expect(isDirectReadable(null)).toBe(false)
  })
})

describe('arcRpcJson direct read lane', () => {
  const ok = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) })
  let calls: string[]
  beforeEach(() => { vi.resetModules(); calls = [] })
  afterEach(() => { vi.unstubAllGlobals() })

  it('reads straight from Circle\'s Arc endpoint and skips the proxy', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return ok('0x1') }))
    const { arcRpcJson } = await import('./arc')
    const { ARC } = await import('@/blockchain/chains')
    expect((await arcRpcJson(BLOCK)).result).toBe('0x1')
    expect(calls).toEqual([ARC.rpcUrl])
  })

  it('falls back to the proxy when the direct request is refused, and stops trying direct for a while', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      if (url.startsWith('http')) throw new TypeError('Failed to fetch') // CORS / network
      return ok('0x2')
    }))
    const { arcRpcJson } = await import('./arc')
    expect((await arcRpcJson(BLOCK)).result).toBe('0x2')
    expect((await arcRpcJson(BLOCK)).result).toBe('0x2')
    expect(calls).toEqual(['https://rpc.testnet.arc.io', '/api/arc-rpc', '/api/arc-rpc'])
  })

  it('lets the proxy answer when the direct node reports an error (reverts, head lag)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return url.startsWith('http')
        ? { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32014, message: 'block not yet imported' } }) }
        : ok('0x3')
    }))
    const { arcRpcJson } = await import('./arc')
    expect((await arcRpcJson({ ...BLOCK, method: 'eth_call' })).result).toBe('0x3')
    expect(calls).toEqual(['https://rpc.testnet.arc.io', '/api/arc-rpc'])
  })

  it('sends everything else only through the proxy', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return ok('0x4') }))
    const { arcRpcJson } = await import('./arc')
    await arcRpcJson({ ...BLOCK, method: 'eth_sendRawTransaction', params: ['0x'] })
    await arcRpcJson({ ...BLOCK, method: 'eth_getTransactionCount', params: ['0x0', 'pending'] })
    expect(calls).toEqual(['/api/arc-rpc', '/api/arc-rpc'])
  })
})
