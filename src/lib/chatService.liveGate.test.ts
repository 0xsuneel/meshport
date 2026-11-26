// The live gate in subscribeWithRetry (docs/SUPABASE_LIGHT_PLAN.md, Phase 4):
// channels close while the app is hidden or idle (so supabase-js closes the
// socket and the device stops counting toward Realtime's 200 connections),
// and come back with a catch-up on the next touch / return.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key')
// The real client would see the fake window and try to start a browser worker.
vi.mock('./supabase', () => ({ supabase: {}, chatApiHeaders: async () => ({}) }))
vi.mock('./adminMode', () => ({ isAdminMode: () => false }))

type Handler = (...a: any[]) => void
function makeTarget() {
  const handlers = new Map<string, Set<Handler>>()
  return {
    addEventListener: (t: string, h: Handler) => { if (!handlers.has(t)) handlers.set(t, new Set()); handlers.get(t)!.add(h) },
    removeEventListener: (t: string, h: Handler) => { handlers.get(t)?.delete(h) },
    fire: (t: string) => { for (const h of [...(handlers.get(t) ?? [])]) h({ type: t }) },
    dispatchEvent: (e: { type: string }) => { for (const h of [...(handlers.get(e.type) ?? [])]) h(e); return true },
  }
}
let doc: ReturnType<typeof makeTarget> & { visibilityState: string }
let win: ReturnType<typeof makeTarget> & { location: { pathname: string } }

function fakeClient() {
  const live = new Set<string>()
  const created: string[] = []
  const client: any = {
    channel: (name: string) => {
      created.push(name)
      const ch: any = {
        name,
        on: () => ch,
        subscribe: (cb: (s: string) => void) => { live.add(name); ch.cb = cb; queueMicrotask(() => cb('SUBSCRIBED')); return ch },
      }
      return ch
    },
    removeChannel: (ch: any) => { live.delete(ch.name); ch.cb?.('CLOSED') },
  }
  return { client, live, created }
}

let svc: typeof import('./chatService')
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  doc = Object.assign(makeTarget(), { visibilityState: 'visible' })
  win = Object.assign(makeTarget(), { location: { pathname: '/' } })
  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', win)
  svc = await import('./chatService')
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

const flush = async () => { await Promise.resolve(); await Promise.resolve() }

describe('live gate', () => {
  it('closes channels 30 s after the app is hidden and reopens them with a catch-up on return', async () => {
    const { client, live } = fakeClient()
    const onReconnect = vi.fn()
    svc.subscribeWithRetry(client, 'feed', c => c, { onReconnect })
    await flush()
    expect(live.size).toBe(1)

    doc.visibilityState = 'hidden'; doc.fire('visibilitychange')
    vi.advanceTimersByTime(29_000)
    expect(live.size).toBe(1) // a quick app switch does not churn
    vi.advanceTimersByTime(2_000)
    expect(live.size).toBe(0)
    expect(svc.isLivePaused()).toBe(true)
    vi.advanceTimersByTime(120_000)
    expect(live.size).toBe(0) // no retry while paused

    const resumed = vi.fn(); win.addEventListener('meshport:live-resumed', resumed)
    doc.visibilityState = 'visible'; doc.fire('visibilitychange')
    await flush()
    expect(live.size).toBe(1)
    expect(onReconnect).toHaveBeenCalledTimes(1)
    expect(resumed).toHaveBeenCalledTimes(1)
  })

  it('pauses after 3 idle minutes off the chat screen; the next touch resumes', async () => {
    const { client, live } = fakeClient()
    svc.subscribeWithRetry(client, 'feed', c => c)
    await flush()
    vi.advanceTimersByTime(3 * 60_000 + 30_000)
    expect(live.size).toBe(0)
    win.fire('pointerdown')
    await flush()
    expect(live.size).toBe(1)
  })

  it('stays live while reading a chat without touching', async () => {
    win.location.pathname = '/chat/abc'
    const { client, live } = fakeClient()
    svc.subscribeWithRetry(client, 'msgs', c => c)
    await flush()
    vi.advanceTimersByTime(10 * 60_000)
    expect(live.size).toBe(1)
  })

  it('exactName keeps the topic as given (broadcast between two people)', async () => {
    const { client, created } = fakeClient()
    svc.subscribeWithRetry(client, 'typing-conv1', c => c, { exactName: true })
    svc.subscribeWithRetry(client, 'feed', c => c)
    expect(created[0]).toBe('typing-conv1')
    expect(created[1]).toMatch(/^feed-\d+-1$/)
  })
})
