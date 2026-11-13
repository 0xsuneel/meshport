// The passcode page kept ready (confirmStandby): taken only when it said it is
// ready and the browser can move it without reloading; one page per payment;
// the next one loads straight after; never in browsers without moveBefore.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/wallet/frameClient', () => ({ walletOrigin: () => 'https://wallet.test' }))

type El = { tag: string; style: Record<string, string>; attrs: Record<string, string>; children: El[]; removed: boolean; src?: string; title?: string; tabIndex?: number; contentWindow?: object;
  setAttribute(k: string, v: string): void; appendChild(c: El): void; remove(): void }
const made: El[] = []
const listeners: ((e: unknown) => void)[] = []
let canMove = true
function element(tag: string): El {
  const e: El = { tag, style: {}, attrs: {}, children: [], removed: false,
    setAttribute(k, v) { this.attrs[k] = v }, appendChild(c) { this.children.push(c) }, remove() { this.removed = true } }
  if (tag === 'iframe') e.contentWindow = {}
  made.push(e)
  return e
}
vi.stubGlobal('window', { addEventListener: (t: string, f: (e: unknown) => void) => { if (t === 'message') listeners.push(f) } })
vi.stubGlobal('document', {
  createElement: element,
  get body() { return { appendChild() {}, ...(canMove ? { moveBefore() {} } : {}) } },
})
const frames = () => made.filter(e => e.tag === 'iframe')
const sayReady = (f: El, origin = 'https://wallet.test') => listeners.forEach(l => l({ origin, source: f.contentWindow, data: { type: 'mp-confirm', state: 'standby' } }))

const { ensureConfirmStandby, takeConfirmStandby, resetConfirmStandby } = await import('./confirmStandby')

describe('confirmStandby', () => {
  beforeEach(() => { vi.useFakeTimers(); made.length = 0; canMove = true; resetConfirmStandby() })
  afterEach(() => vi.useRealTimers())

  it('loads one page in standby, out of sight, with the theme and size', () => {
    ensureConfirmStandby('light', true)
    ensureConfirmStandby('light', true) // already there: nothing more
    expect(frames().length).toBe(1)
    expect(frames()[0].src).toBe('https://wallet.test/confirm.html#standby=1&theme=light&short=1')
    expect(frames()[0].attrs.allow).toBe('publickey-credentials-get')
  })

  it('is only taken once it said it is ready - and only from the wallet origin', () => {
    ensureConfirmStandby('dark', false)
    expect(takeConfirmStandby()).toBeNull()
    sayReady(frames()[0], 'https://evil.test')
    expect(takeConfirmStandby()).toBeNull()
    sayReady(frames()[0])
    expect(takeConfirmStandby()).toBe(frames()[0])
    // One page per payment: taken means gone.
    expect(takeConfirmStandby()).toBeNull()
  })

  it('loads the next one straight after one is taken', () => {
    ensureConfirmStandby('dark', false)
    sayReady(frames()[0])
    takeConfirmStandby()
    vi.advanceTimersByTime(400)
    expect(frames().length).toBe(2)
    expect(frames()[1].removed).toBe(false)
  })

  it('drops a page that never gets ready, and waits a minute before trying again', () => {
    ensureConfirmStandby('dark', false)
    vi.advanceTimersByTime(20_001)
    expect(frames()[0].removed).toBe(true)
    ensureConfirmStandby('dark', false)
    expect(frames().length).toBe(1)
    vi.advanceTimersByTime(60_000)
    ensureConfirmStandby('dark', false)
    expect(frames().length).toBe(2)
  })

  it('replaces a stale one (10 min), and a stuck one when asked', () => {
    ensureConfirmStandby('dark', false)
    ensureConfirmStandby('dark', false, { replaceUnready: true }) // not ready yet: replaced
    expect(frames().length).toBe(2)
    expect(frames()[0].removed).toBe(true)
    sayReady(frames()[1])
    ensureConfirmStandby('dark', false, { replaceUnready: true }) // ready: kept
    expect(frames().length).toBe(2)
    vi.advanceTimersByTime(10 * 60_000 + 1)
    expect(takeConfirmStandby()).toBeNull() // too old to use
    ensureConfirmStandby('dark', false)
    expect(frames().length).toBe(3)
  })

  it('never in a browser that would reload a moved page', () => {
    canMove = false
    ensureConfirmStandby('dark', false)
    expect(frames().length).toBe(0)
    expect(takeConfirmStandby()).toBeNull()
  })
})
