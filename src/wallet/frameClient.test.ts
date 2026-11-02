import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/perfTrace', () => ({ markStartup: () => {}, noteStartupDetail: () => {} }))

// A minimal browser for frameClient: iframes whose page either loads and
// answers, loads and stays silent (a browser error page), or never loads.
type Behaviour = 'answers' | 'silent' | 'never-loads'
const messageListeners: ((e: unknown) => void)[] = []
const frames: FakeFrame[] = []
let behaviours: Behaviour[] = []

class FakeFrame {
  src = ''; title = ''; tabIndex = 0; referrerPolicy = ''; style = { cssText: '' }
  isConnected = false
  private loadListeners: (() => void)[] = []
  constructor(public behaviour: Behaviour) {}
  contentWindow = {
    postMessage: (msg: { tag: string; v: number; id: string; method: string }, origin: string) => {
      if (this.behaviour !== 'answers' || !this.isConnected) return
      queueMicrotask(() => messageListeners.forEach(l => l({
        origin, source: this.contentWindow,
        data: { tag: msg.tag, v: msg.v, id: msg.id, result: { version: msg.v } },
      })))
    },
  }
  setAttribute() {}
  addEventListener(type: string, cb: () => void) { if (type === 'load') this.loadListeners.push(cb) }
  remove() { this.isConnected = false }
  load() { this.loadListeners.forEach(cb => cb()) }
}

vi.stubGlobal('window', {
  addEventListener: (t: string, l: (e: unknown) => void) => { if (t === 'message') messageListeners.push(l) },
  removeEventListener: (t: string, l: (e: unknown) => void) => {
    const i = messageListeners.indexOf(l); if (t === 'message' && i >= 0) messageListeners.splice(i, 1)
  },
})
vi.stubGlobal('document', {
  createElement: () => {
    const f = new FakeFrame(behaviours[frames.length] ?? 'answers')
    frames.push(f)
    return f
  },
  body: {
    appendChild: (f: FakeFrame) => {
      f.isConnected = true
      // The page loads a moment later (or never).
      if (f.behaviour !== 'never-loads') setTimeout(() => f.load(), 200)
    },
  },
})

const { walletReady, resetWalletFrame } = await import('./frameClient')

describe('wallet frame loading', () => {
  beforeEach(() => { vi.useFakeTimers(); frames.length = 0; behaviours = []; resetWalletFrame() })
  afterEach(() => { vi.useRealTimers() })

  it('a healthy frame is loaded once', async () => {
    behaviours = ['answers']
    const ready = walletReady()
    await vi.advanceTimersByTimeAsync(500)
    await expect(ready).resolves.toBeUndefined()
    expect(frames.length).toBe(1)
  })

  it('a frame that loaded but never answers (error page) is replaced within the same wait', async () => {
    behaviours = ['silent', 'answers']
    const ready = walletReady()
    ready.catch(() => {})
    await vi.advanceTimersByTimeAsync(6_000)
    await expect(ready).resolves.toBeUndefined()
    expect(frames.length).toBe(2)
    expect(frames[0].isConnected).toBe(false)
    expect(frames[1].isConnected).toBe(true)
  })

  it('a frame that never loads is dropped when the wait ends, so the retry loads a fresh one', async () => {
    behaviours = ['never-loads', 'answers']
    const first = walletReady()
    first.catch(() => {})
    await vi.advanceTimersByTimeAsync(16_000)
    await expect(first).rejects.toMatchObject({ code: 'unavailable' })
    expect(frames[0].isConnected).toBe(false)

    // restoreWallet's retry: a new frame, not the same dead one.
    const second = walletReady()
    await vi.advanceTimersByTimeAsync(500)
    await expect(second).resolves.toBeUndefined()
    expect(frames.length).toBe(2)
  })
})
