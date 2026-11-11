import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules() })

function fakeWindow(withRic = false) {
  const listeners: Record<string, Array<() => void>> = {}
  const w: any = {
    addEventListener: (e: string, f: () => void) => { (listeners[e] ||= []).push(f) },
    setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
  }
  if (withRic) { w.requestIdleCallback = vi.fn(() => 7); w.cancelIdleCallback = vi.fn() }
  vi.stubGlobal('window', w)
  return { w, fire: (e: string) => listeners[e]?.forEach(f => f()) }
}

describe('whenIdle', () => {
  it('uses requestIdleCallback where it exists', async () => {
    const { w } = fakeWindow(true)
    const { whenIdle } = await import('./idle')
    const cancel = whenIdle(() => {}, { timeout: 1234 })
    expect(w.requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 1234 })
    cancel()
    expect(w.cancelIdleCallback).toHaveBeenCalledWith(7)
  })

  it('without it (Safari), waits for a quiet moment after input', async () => {
    const { fire } = fakeWindow()
    const { whenIdle } = await import('./idle')
    const cb = vi.fn()
    whenIdle(cb, { timeout: 5000 })
    fire('touchstart') // the person is scrolling
    vi.advanceTimersByTime(300)
    fire('scroll')
    vi.advanceTimersByTime(400)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300) // 600ms with no input
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('runs anyway at the timeout, and can be cancelled', async () => {
    const { fire } = fakeWindow()
    const { whenIdle } = await import('./idle')
    const cb = vi.fn(), never = vi.fn()
    whenIdle(cb, { timeout: 1000 })
    const cancel = whenIdle(never, { timeout: 1000 })
    cancel()
    for (let i = 0; i < 10; i++) { fire('wheel'); vi.advanceTimersByTime(100) }
    expect(cb).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5000)
    expect(never).not.toHaveBeenCalled()
  })
})
