// The database client's fetch gives up after 20 s, so one lost reply can't
// hold every database call behind it (lib/supabase.ts timedFetch).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { timedFetch, SUPABASE_FETCH_TIMEOUT_MS } from './supabase'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

/** A fetch that never answers - until its signal aborts. */
function hangingFetch() {
  return vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
    init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
  }))
}

describe('timedFetch', () => {
  it('a database request that never answers fails after the limit', async () => {
    vi.useFakeTimers()
    const f = hangingFetch(); vi.stubGlobal('fetch', f)
    const p = timedFetch('https://x.supabase.co/rest/v1/merchant_payments?select=*')
    const settled = vi.fn(); p.catch(settled)
    await vi.advanceTimersByTimeAsync(SUPABASE_FETCH_TIMEOUT_MS - 1)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('sign-in requests are limited too', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', hangingFetch())
    const p = timedFetch('https://x.supabase.co/auth/v1/user')
    const settled = vi.fn(); p.catch(settled)
    await vi.advanceTimersByTimeAsync(SUPABASE_FETCH_TIMEOUT_MS + 1)
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('uploads and server functions keep no limit', async () => {
    const f = vi.fn(async () => new Response('ok')); vi.stubGlobal('fetch', f)
    await timedFetch('https://x.supabase.co/storage/v1/object/chat/a.jpg', { method: 'POST' })
    await timedFetch('https://x.supabase.co/functions/v1/merchant-pay', { method: 'POST' })
    for (const call of f.mock.calls as unknown as [string, RequestInit | undefined][]) expect(call[1]?.signal).toBeUndefined()
  })

  it('a quick answer comes straight through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })))
    const r = await timedFetch('https://x.supabase.co/rest/v1/users')
    expect(r.status).toBe(200)
  })
})
