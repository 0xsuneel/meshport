import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const prewarm = vi.fn()
vi.mock('./walletConfirm', () => ({ prewarmWalletConfirm: (...a: unknown[]) => prewarm(...a) }))
const state = { walletAddress: null as string | null, passcode: null as string | null }
const subs: Array<() => void> = []
vi.mock('@/store', () => ({ useAuthStore: { getState: () => state, subscribe: (f: () => void) => { subs.push(f) } } }))

const listeners: Record<string, Array<() => void>> = {}
let visibility = 'visible'
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { addEventListener: (t: string, f: () => void) => { (listeners['win:' + t] ??= []).push(f) } })
  vi.stubGlobal('navigator', { connection: { addEventListener: (t: string, f: () => void) => { (listeners['net:' + t] ??= []).push(f) } } })
  vi.stubGlobal('document', {
    get visibilityState() { return visibility },
    documentElement: { getAttribute: () => 'light' },
    addEventListener: (t: string, f: () => void) => { (listeners[t] ??= []).push(f) },
  })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

const flush = async () => { await vi.dynamicImportSettled(); for (let i = 0; i < 5; i++) await Promise.resolve() }

describe('walletWarmth', () => {
  it('warms once a wallet with a passcode appears, keeps warm while in use, stops when idle', async () => {
    const { installWalletWarmth } = await import('./walletWarmth')
    installWalletWarmth()
    vi.advanceTimersByTime(1000); await flush()
    expect(prewarm).not.toHaveBeenCalled() // no wallet yet (sign-up screen)
    state.walletAddress = '0xabc'; state.passcode = 'h'; subs.forEach(f => f())
    vi.advanceTimersByTime(800); await flush()
    expect(prewarm).toHaveBeenCalledTimes(1)
    expect(prewarm).toHaveBeenLastCalledWith('light', { refresh: true, force: false })
    vi.advanceTimersByTime(45_000); await flush()
    expect(prewarm).toHaveBeenCalledTimes(2) // in use: heartbeat
    vi.advanceTimersByTime(4 * 60_000); await flush()
    const afterIdle = prewarm.mock.calls.length
    vi.advanceTimersByTime(3 * 45_000); await flush()
    expect(prewarm.mock.calls.length).toBe(afterIdle) // idle: no more
    listeners.visibilitychange.forEach(f => f()); await flush()
    expect(prewarm.mock.calls.length).toBe(afterIdle + 1) // back to the front
    expect(prewarm).toHaveBeenLastCalledWith('light', { refresh: true, force: true }) // the connection may be gone
    listeners['net:change'].forEach(f => f()); await flush()
    expect(prewarm).toHaveBeenLastCalledWith('light', { refresh: true, force: true }) // 3G ↔ 4G: a new connection now
    expect(prewarm.mock.calls.length).toBe(afterIdle + 2)
    listeners['win:online'].forEach(f => f()); await flush()
    expect(prewarm.mock.calls.length).toBe(afterIdle + 3) // back online
  })
})
