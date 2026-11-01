import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { hedgedFetch } from './hedgedApi'

const ok = (body = 'ok') => new Response(body, { status: 200 })
const after = <T>(ms: number, v: T | (() => T), signal?: AbortSignal) => new Promise<T>((res, rej) => {
  const t = setTimeout(() => res(typeof v === 'function' ? (v as () => T)() : v), ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })) })
})

describe('hedgedFetch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a quick direct answer never sends the relay', async () => {
    const relay = vi.fn()
    const p = hedgedFetch({ hedgeAfterMs: 2000, timeoutMs: 20000, direct: s => after(300, ok('d'), s), relay })
    await vi.advanceTimersByTimeAsync(300)
    const r = await p
    expect(r.via).toBe('direct')
    expect(relay).not.toHaveBeenCalled()
  })

  it('a stalled direct request is overtaken by the relay (field 1 Nov: 9-13 s stalls)', async () => {
    let directAborted = false
    const p = hedgedFetch({
      hedgeAfterMs: 2000, timeoutMs: 20000,
      direct: s => { s.addEventListener('abort', () => { directAborted = true }); return after(13000, ok('d'), s) },
      relay: s => after(600, ok('r'), s),
    })
    await vi.advanceTimersByTimeAsync(2600)
    const r = await p
    expect(r.via).toBe('relay')
    expect(await r.res.text()).toBe('r')
    expect(directAborted).toBe(true)
  })

  it('a relay error does not beat a slow but working direct request', async () => {
    const p = hedgedFetch({
      hedgeAfterMs: 2000, timeoutMs: 20000,
      direct: s => after(5000, ok('d'), s),
      relay: s => after(100, new Response('no', { status: 401 }), s),
    })
    await vi.advanceTimersByTimeAsync(5000)
    expect((await p).via).toBe('direct')
  })

  it('a direct request that fails fast goes to the relay at once', async () => {
    const p = hedgedFetch({
      hedgeAfterMs: 2000, timeoutMs: 20000,
      direct: () => Promise.reject(new TypeError('Failed to fetch')),
      relay: s => after(200, ok('r'), s),
    })
    await vi.advanceTimersByTimeAsync(200)
    expect((await p).via).toBe('relay')
  })

  it('gives up at the timeout when neither answers', async () => {
    const p = hedgedFetch({ hedgeAfterMs: 2000, timeoutMs: 20000, direct: s => after(60000, ok(), s), relay: s => after(60000, ok(), s) })
    const caught = p.catch(e => e)
    await vi.advanceTimersByTimeAsync(20000)
    expect((await caught).name).toBe('TimeoutError')
  })
})
