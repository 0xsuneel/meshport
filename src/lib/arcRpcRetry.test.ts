import { describe, it, expect, vi, afterEach } from 'vitest'
import { arcRpcJson, isRepeatableRead } from './arc'
import { beforeSending, FastCctpError, ARC_UNREACHABLE } from './fastCctp'

const timeout = () => Object.assign(new Error('signal timed out'), { name: 'TimeoutError' })
const ok = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) })

describe('a lost Arc read is asked again (field 1 Nov: nonce read never reached the proxy)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('reads repeat; sends never do', () => {
    expect(isRepeatableRead({ method: 'eth_getTransactionCount' })).toBe(true)
    expect(isRepeatableRead({ method: 'eth_call' })).toBe(true)
    expect(isRepeatableRead({ method: 'eth_sendRawTransaction' })).toBe(false)
    expect(isRepeatableRead({ method: 'meshport_sendRawTransactionAndWait' })).toBe(false)
    expect(isRepeatableRead([{ method: 'eth_call' }])).toBe(false)
  })

  it('a nonce read that times out once still answers', async () => {
    const f = vi.fn().mockRejectedValueOnce(timeout()).mockResolvedValue(ok('0x7'))
    vi.stubGlobal('fetch', f)
    const r = await arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: ['0x1', 'pending'] })
    expect(r.result).toBe('0x7')
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('a send that times out is not sent again', async () => {
    const f = vi.fn().mockRejectedValue(timeout())
    vi.stubGlobal('fetch', f)
    await expect(arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0x00'] })).rejects.toThrow(/timed out/)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it("a node's own answer (JSON-RPC error) is not retried", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ error: { code: -32000, message: 'bad' } }) })
    vi.stubGlobal('fetch', f)
    await expect(arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [] })).rejects.toMatchObject({ code: -32000 })
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('beforeSending', () => {
  it('a lost connection before signing says nothing was sent', async () => {
    await expect(beforeSending(Promise.reject(timeout()))).rejects.toMatchObject({ kind: 'not_sent', message: ARC_UNREACHABLE })
    await expect(beforeSending(Promise.reject(new TypeError('Failed to fetch')))).rejects.toBeInstanceOf(FastCctpError)
  })
  it('anything else passes through', async () => {
    const e = new Error('insufficient balance')
    await expect(beforeSending(Promise.reject(e))).rejects.toBe(e)
    expect(await beforeSending(Promise.resolve(3))).toBe(3)
  })
})

describe("Circle's kit reads Arc through arcRpcJson (ethers waits 300 s on its own)", () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('proxy unreachable twice: a read is answered by Circle\'s Arc node directly', async () => {
    const f = vi.fn(async (url: string) => {
      if (String(url).includes('/api/arc-rpc')) throw timeout()
      return ok('0x9')
    })
    vi.stubGlobal('fetch', f)
    const r = await arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: ['0x1', 'pending'] })
    expect(r.result).toBe('0x9')
  })

  it('an ethers provider routed through it answers reads, keeps ids, and returns node errors as errors', async () => {
    const { readThroughArcRpc } = await import('./arcRelaySend')
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => {
      const b = JSON.parse(init.body)
      if (b.method === 'eth_call') return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: b.id, error: { code: 3, message: 'execution reverted: nope', data: '0x08c379a0' } }) }
      return ok('0x2a')
    }))
    const provider: any = { _send: vi.fn() }
    readThroughArcRpc(provider)
    const out = await provider._send([{ id: 5, method: 'eth_blockNumber', params: [] }, { id: 6, method: 'eth_call', params: [{}] }])
    expect(out[0]).toMatchObject({ id: 5, result: '0x2a' })
    expect(out[1]).toMatchObject({ id: 6, error: { code: 3, message: 'execution reverted: nope', data: '0x08c379a0' } })
    expect(provider._send).not.toBe(undefined)
  })
})
