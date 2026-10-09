// /api/portfolio: one request returns Arc + every external chain's USDC.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EXTERNAL_CHAINS } from '@/blockchain/chains'

const ADDR = '0x05d0b5ba1fdf4b0dc6a2fe6e0f4e7c0fe5e126e0'
const DEAD = 'https://dead.example'

function mockFetch() {
  const fn = vi.fn(async (url: string, init: any) => {
    const body = JSON.parse(init.body)
    if (url.startsWith(DEAD)) throw new TypeError('fetch failed')
    let result = '0x0'
    if (body.method === 'eth_getBalance') result = '0x' + (25n * 10n ** 18n).toString(16)          // 25 USDC (18 dec)
    else if (body.method === 'eth_call') result = '0x' + (7_500_000n).toString(16)                  // 7.5 (6 dec)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}
function call(handler: any, address: string) {
  return new Promise<{ code: number; body: any }>(resolve => {
    const res: any = { setHeader() {}, status(c: number) { this.c = c; return this }, json(d: any) { resolve({ code: this.c, body: d }) }, end() { resolve({ code: this.c, body: null }) } }
    handler({ method: 'GET', headers: {}, query: { address } }, res)
  })
}

describe('/api/portfolio', () => {
  beforeEach(() => { vi.resetModules(); vi.unstubAllGlobals() })

  it('returns Arc balances and every chain in one response', async () => {
    mockFetch()
    const { default: handler } = await import('../../api/portfolio')
    const { code, body } = await call(handler, ADDR)
    expect(code).toBe(200)
    expect(body.arc.USDC).toBe(25)
    expect(body.arc.EURC).toBe(7.5)
    expect(Object.keys(body.chains).sort()).toEqual(Object.keys(EXTERNAL_CHAINS).sort())
    expect(body.chains.Base_Sepolia).toBe(7.5)
  })

  it('a chain whose endpoints all fail is null (not a fake 0); bad address is rejected', async () => {
    mockFetch()
    // Same module instance the handler will load (after resetModules).
    const { EXTERNAL_CHAINS: live } = await import('../blockchain/chains')
    const orig = live.Base_Sepolia.rpcs
    live.Base_Sepolia.rpcs = [DEAD + '/a', DEAD + '/b']
    try {
      const { default: handler } = await import('../../api/portfolio')
      const { body } = await call(handler, ADDR)
      expect(body.chains.Base_Sepolia).toBeNull()
      expect(body.chains.Ethereum_Sepolia).toBe(7.5)
      expect((await call(handler, '0x123')).code).toBe(400)
    } finally { live.Base_Sepolia.rpcs = orig }
  })

  it('a burst of requests for one wallet shares one read', async () => {
    const fn = mockFetch()
    const { default: handler } = await import('../../api/portfolio')
    await Promise.all([call(handler, ADDR), call(handler, ADDR), call(handler, ADDR)])
    const first = fn.mock.calls.length
    await call(handler, ADDR) // cached
    expect(fn.mock.calls.length).toBe(first)
  })
})
