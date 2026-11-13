// /api/arc-rpc forward(): once one endpoint answers, the other attempts are
// cancelled and not counted as failures. Left running they outlived the
// response, "timed out" after Vercel froze and thawed the function, and
// quarantined healthy endpoints until callers saw "upstream unavailable".
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('arc-rpc race', () => {
  beforeEach(() => { vi.resetModules(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('cancels the losing attempts without quarantining them', async () => {
    const signals: AbortSignal[] = []
    let calls = 0
    vi.stubGlobal('fetch', vi.fn((_url: string, init: any) => {
      const { id } = JSON.parse(init.body)
      signals.push(init.signal)
      if (calls++ === 0) return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id, result: '0x1' }), { status: 200 }))
      // The others hang until cancelled, like a slow node.
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
    }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mod: any = await import('../../api/arc-rpc.js')

    // Let the staggered attempts start before the first answers.
    const slowFirst = vi.mocked(fetch)
    slowFirst.mockClear(); calls = 0; signals.length = 0
    const r = await mod.forward({ jsonrpc: '2.0', id: 7, method: 'eth_chainId', params: [] })
    expect(r.result).toBe('0x1')

    await new Promise(res => setTimeout(res, 400)) // past every stagger
    expect(signals.every(s => s.aborted)).toBe(true)
    expect(errors.mock.calls.some(c => /failed/.test(String(c[0])))).toBe(false)
  })

  it('a real failure still quarantines (and the race still answers from another endpoint)', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn((_url: string, init: any) => {
      const { id } = JSON.parse(init.body)
      if (calls++ === 0) return Promise.resolve(new Response('busy', { status: 503 }))
      return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id, result: '0x2' }), { status: 200 }))
    }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mod: any = await import('../../api/arc-rpc.js')
    const r = await mod.forward({ jsonrpc: '2.0', id: 8, method: 'eth_chainId', params: [] })
    expect(r.result).toBe('0x2')
    expect(errors.mock.calls.some(c => /failed: HTTP 503/.test(String(c[0])))).toBe(true)
  })
})

describe('arc-rpc ranking', () => {
  beforeEach(() => { vi.resetModules(); vi.unstubAllEnvs() })

  async function load() {
    vi.stubEnv('DRPC_KEY', 'k1')
    vi.stubEnv('ALCHEMY_ARC_KEY', 'k2')
    const mod: any = await import('../../api/arc-rpc.js')
    const { ARC_RPCS, recordSuccess, orderEndpoints, healthScore } = mod._ranking
    const drpc = ARC_RPCS.find((u: string) => u.includes('drpc.live'))
    const alchemy = ARC_RPCS.find((u: string) => u.includes('alchemy'))
    return { drpc, alchemy, recordSuccess, orderEndpoints, healthScore }
  }

  it('a faster, equally reliable endpoint ranks first', async () => {
    const { drpc, alchemy, recordSuccess, healthScore } = await load()
    for (let i = 0; i < 20; i++) { recordSuccess(drpc, 175); recordSuccess(alchemy, 115) }
    expect(healthScore(alchemy)).toBeGreaterThan(healthScore(drpc))
  })

  it('an authenticated endpoint still ranks above a faster public one', async () => {
    const { alchemy, recordSuccess, healthScore } = await load()
    for (let i = 0; i < 20; i++) { recordSuccess(alchemy, 115); recordSuccess('https://rpc.testnet.arc.io', 95) }
    expect(healthScore(alchemy)).toBeGreaterThan(healthScore('https://rpc.testnet.arc.io'))
  })

  it('every 8th order puts the runner-up first, so its speed gets measured', async () => {
    const { orderEndpoints } = await load()
    const firsts = Array.from({ length: 16 }, () => orderEndpoints()[0])
    const top = firsts[0]
    expect(firsts.filter(u => u !== top)).toHaveLength(2)
    expect(firsts[7]).not.toBe(top)
    expect(firsts[15]).not.toBe(top)
  })
})

// Logs 1 Nov: dRPC and Alchemy send a JSON-RPC error with HTTP 400; the proxy
// threw on the status, so a correct answer benched the authenticated nodes.
describe('arc-rpc: a JSON-RPC answer sent with HTTP 400', () => {
  beforeEach(() => { vi.resetModules(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('a revert sent as 400 is the answer, not a broken endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      const { id } = JSON.parse(init.body)
      return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted: ERC20: transfer amount exceeds balance' } }), { status: 400 }))
    }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const mod: any = await import('../../api/arc-rpc.js')
    const r = await mod.forward({ jsonrpc: '2.0', id: 9, method: 'eth_estimateGas', params: [{}] })
    expect(r.error.message).toMatch(/execution reverted/)
    expect(errors.mock.calls.some(c => /failed/.test(String(c[0])))).toBe(false)
  })

  it('a 400 without a JSON-RPC body is still a failure', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      const { id } = JSON.parse(init.body)
      if (calls++ === 0) return Promise.resolve(new Response('bad request', { status: 400 }))
      return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id, result: '0x3' }), { status: 200 }))
    }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const mod: any = await import('../../api/arc-rpc.js')
    const r = await mod.forward({ jsonrpc: '2.0', id: 10, method: 'eth_chainId', params: [] })
    expect(r.result).toBe('0x3')
    expect(errors.mock.calls.some(c => /failed: HTTP 400/.test(String(c[0])))).toBe(true)
  })
})

// Field 13 Nov: one endpoint answered fastest with a chain head 320 blocks old
// (13 of 15 calls) - payments waited for receipts it didn't have yet.
describe('arc-rpc chain-head freshness', () => {
  beforeEach(() => { vi.resetModules(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

  /** Endpoints by host → their head; the stale one answers first. */
  function chain(heads: Record<string, number>, seen: string[] = []) {
    vi.stubGlobal('fetch', vi.fn((url: string, init: any) => {
      const body = JSON.parse(init.body)
      const host = new URL(url).host
      seen.push(`${host} ${body.method}`)
      const head = heads[host]
      const delay = head === Math.min(...Object.values(heads)) ? 5 : 60 // the stale one is the fastest
      const result = body.method === 'eth_blockNumber' ? '0x' + head.toString(16)
        : body.method === 'eth_getTransactionReceipt' ? (head >= 1000 ? { blockNumber: '0x3e8', status: '0x1' } : null)
        : '0x1'
      return new Promise(res => setTimeout(() => res(new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 })), delay))
    }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  }

  it('eth_blockNumber is the highest head, not the fastest answer - and the stale endpoint is benched', async () => {
    chain({ 'rpc.testnet.arc.io': 1000, 'rpc.blockdaemon.testnet.arc.io': 1001, 'rpc.drpc.testnet.arc.io': 680, 'rpc.quicknode.testnet.arc.io': 1000 })
    const mod: any = await import('../../api/arc-rpc.js')
    const r = await mod.forward({ jsonrpc: '2.0', id: 3, method: 'eth_blockNumber', params: [] })
    expect(parseInt(r.result, 16)).toBe(1001)
    const order: string[] = mod._ranking.orderEndpoints().map((u: string) => new URL(u).host)
    expect(order).not.toContain('rpc.drpc.testnet.arc.io')
  })

  it('a receipt is then read from a current endpoint, not the stale one', async () => {
    const seen: string[] = []
    chain({ 'rpc.testnet.arc.io': 1000, 'rpc.blockdaemon.testnet.arc.io': 1000, 'rpc.drpc.testnet.arc.io': 680, 'rpc.quicknode.testnet.arc.io': 1000 }, seen)
    const mod: any = await import('../../api/arc-rpc.js')
    await mod.forward({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
    seen.length = 0
    const rc = await mod.forward({ jsonrpc: '2.0', id: 2, method: 'eth_getTransactionReceipt', params: ['0x' + 'ab'.repeat(32)] })
    expect(rc.result).toEqual({ blockNumber: '0x3e8', status: '0x1' })
    expect(seen.some(s => s.startsWith('rpc.drpc.testnet.arc.io') && s.endsWith('eth_getTransactionReceipt'))).toBe(false)
  })

  it('a stale endpoint is found even when nothing asks for eth_blockNumber (checked alongside a receipt read)', async () => {
    chain({ 'rpc.testnet.arc.io': 1000, 'rpc.blockdaemon.testnet.arc.io': 1000, 'rpc.drpc.testnet.arc.io': 680, 'rpc.quicknode.testnet.arc.io': 1000 })
    const mod: any = await import('../../api/arc-rpc.js')
    await mod.forward({ jsonrpc: '2.0', id: 2, method: 'eth_getTransactionReceipt', params: ['0x' + 'cd'.repeat(32)] })
    await new Promise(res => setTimeout(res, 500)) // the background check finishes
    const order: string[] = mod._ranking.orderEndpoints().map((u: string) => new URL(u).host)
    expect(order).not.toContain('rpc.drpc.testnet.arc.io')
  })

  it('every endpoint behind: still answered (a lagging node beats none)', async () => {
    chain({ 'rpc.testnet.arc.io': 500, 'rpc.blockdaemon.testnet.arc.io': 500, 'rpc.drpc.testnet.arc.io': 500, 'rpc.quicknode.testnet.arc.io': 500 })
    const mod: any = await import('../../api/arc-rpc.js')
    const r = await mod.forward({ jsonrpc: '2.0', id: 4, method: 'eth_chainId', params: [] })
    expect(r.result).toBe('0x1')
    expect(mod._ranking.orderEndpoints().length).toBeGreaterThan(0)
  })
})
