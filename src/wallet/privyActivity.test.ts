import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { noteHeard, whenPrivyQuiet, resetPrivyActivity } from './privyActivity'

describe('whenPrivyQuiet: stuck, not slow', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); resetPrivyActivity() })
  afterEach(() => { vi.useRealTimers() })
  const now = () => performance.now()

  it('Privy silent while the app is answered: stuck', () => {
    const stuck = vi.fn()
    whenPrivyQuiet(now(), 8_000, stuck)
    vi.advanceTimersByTime(4_000); noteHeard(false, now())
    vi.advanceTimersByTime(4_001)
    expect(stuck).toHaveBeenCalledTimes(1)
  })

  it('a slow connection where Privy keeps answering: left alone', () => {
    const stuck = vi.fn()
    whenPrivyQuiet(now(), 8_000, stuck)
    for (let i = 0; i < 10; i++) { vi.advanceTimersByTime(5_000); noteHeard(true, now()); noteHeard(false, now()) }
    expect(stuck).not.toHaveBeenCalled()
  })

  it('nothing answered at all (offline): no rebuild until the network is back', () => {
    const stuck = vi.fn()
    whenPrivyQuiet(now(), 8_000, stuck)
    vi.advanceTimersByTime(20_000)
    expect(stuck).not.toHaveBeenCalled()
    noteHeard(false, now()) // back online, Privy still silent
    expect(stuck).toHaveBeenCalledTimes(1)
  })

  it('cancelled (Privy loaded / unmounted): never fires', () => {
    const stuck = vi.fn()
    const cancel = whenPrivyQuiet(now(), 8_000, stuck)
    noteHeard(false, now())
    cancel()
    vi.advanceTimersByTime(20_000); noteHeard(false, now())
    expect(stuck).not.toHaveBeenCalled()
  })
})
