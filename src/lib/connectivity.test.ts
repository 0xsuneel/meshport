import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { onReconnect, isOnline, __setOnlineForTest } from './connectivity'

describe('connectivity', () => {
  beforeEach(() => { vi.useFakeTimers(); __setOnlineForTest(true) ; vi.runAllTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('reloads once, shortly after the connection comes back', () => {
    const reload = vi.fn()
    const off = onReconnect(reload)
    __setOnlineForTest(false)
    expect(isOnline()).toBe(false)
    __setOnlineForTest(true)
    expect(reload).not.toHaveBeenCalled() // waits for the network to settle
    vi.advanceTimersByTime(1000)
    expect(reload).toHaveBeenCalledTimes(1)
    off()
  })

  it('a connection that drops again before settling never reloads', () => {
    const reload = vi.fn()
    const off = onReconnect(reload)
    __setOnlineForTest(false)
    __setOnlineForTest(true)
    vi.advanceTimersByTime(300)
    __setOnlineForTest(false)
    vi.advanceTimersByTime(2000)
    expect(reload).not.toHaveBeenCalled()
    off()
  })

  it('staying online, or unsubscribed, does nothing', () => {
    const reload = vi.fn()
    const off = onReconnect(reload)
    __setOnlineForTest(true)
    vi.advanceTimersByTime(2000)
    expect(reload).not.toHaveBeenCalled()
    off()
    __setOnlineForTest(false); __setOnlineForTest(true); vi.advanceTimersByTime(2000)
    expect(reload).not.toHaveBeenCalled()
  })
})
