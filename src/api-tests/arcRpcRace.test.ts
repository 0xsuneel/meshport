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
    const r = await mod.forward({ jsonrpc: '2.0', id: 7, method: 'eth_blockNumber', params: [] })
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
    const r = await mod.forward({ jsonrpc: '2.0', id: 8, method: 'eth_blockNumber', params: [] })
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
