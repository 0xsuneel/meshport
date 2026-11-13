import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/perfTrace', () => ({ markStartup: () => {}, noteStartupDetail: () => {} }))
vi.mock('@/lib/walletEvents', () => ({ logWalletEvent: () => {} }))

// A minimal browser for frameClient: iframes whose page either loads and
// answers, loads and stays silent (a browser error page), or never loads.
type Behaviour = 'answers' | 'silent' | 'never-loads'
const messageListeners: ((e: unknown) => void)[] = []
const frames: FakeFrame[] = []
let behaviours: Behaviour[] = []
// How an answering frame replies to a request other than the default (a pong).
let responder: ((msg: { method: string }) => { result?: unknown; error?: unknown } | undefined) | null = null

class FakeFrame {
  src = ''; title = ''; tabIndex = 0; referrerPolicy = ''; style = { cssText: '' }
  isConnected = false
  private loadListeners: (() => void)[] = []
  constructor(public behaviour: Behaviour) {}
  contentWindow = {
    postMessage: (msg: { tag: string; v: number; id: string; method: string }, origin: string) => {
      if (this.behaviour !== 'answers' || !this.isConnected) return
      const answer = responder?.(msg) ?? { result: { version: msg.v } }
      queueMicrotask(() => messageListeners.forEach(l => l({
        origin, source: this.contentWindow,
        data: { tag: msg.tag, v: msg.v, id: msg.id, ...answer },
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

const { walletReady, resetWalletFrame, callWallet, WalletFrameError } = await import('./frameClient')

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

describe('loading the frame again', () => {
  beforeEach(() => { vi.useFakeTimers(); frames.length = 0; behaviours = []; resetWalletFrame() })
  afterEach(() => { vi.useRealTimers() })
  it('fetches a fresh copy (a one-off address), never the kept page that did not answer', async () => {
    behaviours = ['silent', 'answers']
    const p = walletReady()
    await vi.advanceTimersByTimeAsync(6000)
    await p
    expect(frames.length).toBe(2)
    expect(frames[0].src).toMatch(/\/$/)
    expect(frames[1].src).toMatch(/\/\?r=1-[0-9a-z]+$/)
  })
})

describe('a frame that lost the open wallet (it was loaded afresh)', () => {
  const address = '0x' + 'ab'.repeat(20)
  beforeEach(() => { vi.useFakeTimers(); frames.length = 0; behaviours = ['answers']; resetWalletFrame() })
  afterEach(() => { vi.useRealTimers(); responder = null })
  const locked = { error: { code: 'locked', message: 'Wallet is locked' } }

  it('reopens from the session copy and runs the request again', async () => {
    const asked: string[] = []
    let open = false
    responder = msg => {
      asked.push(msg.method)
      if (msg.method === 'unlock') { open = true; return { result: { unlocked: true, lockedForMs: 0 } } }
      if (msg.method === 'sign:message') return open ? { result: { signature: '0xsig' } } : locked
    }
    const p = callWallet('sign:message', { address, message: 'MeshPort sign-in\nx' })
    await vi.advanceTimersByTimeAsync(300)
    expect(await p).toEqual({ signature: '0xsig' })
    expect(asked.filter(m => m !== 'ping')).toEqual(['sign:message', 'unlock', 'sign:message'])
  })

  it('stays locked when there is no session copy - and does not ask again for a few seconds', async () => {
    const asked: string[] = []
    responder = msg => {
      asked.push(msg.method)
      if (msg.method === 'unlock') return { result: { unlocked: false, lockedForMs: 0 } }
      if (msg.method === 'sign:message') return locked
    }
    const p = callWallet('sign:message', { address, message: 'x' }).catch(e => e)
    await vi.advanceTimersByTimeAsync(300)
    expect((await p) instanceof WalletFrameError && (await p).code).toBe('locked')
    const q = callWallet('sign:message', { address, message: 'x' }).catch(e => e)
    await vi.advanceTimersByTimeAsync(50)
    expect((await q).code).toBe('locked')
    expect(asked.filter(m => m === 'unlock').length).toBe(1)
  })

  it('carries why an approval was refused', async () => {
    responder = msg => msg.method === 'sign:transaction'
      ? { error: { code: 'approval-required', message: 'Confirm this in your wallet', reason: 'expired' } } : undefined
    const p = callWallet('sign:transaction', { address, transaction: {} }).catch(e => e)
    await vi.advanceTimersByTimeAsync(300)
    const e = await p
    expect(e.code).toBe('approval-required')
    expect(e.reason).toBe('expired')
  })
})
