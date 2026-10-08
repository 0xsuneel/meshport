import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { onReconnect, isOnline, __setOnlineForTest } from './connectivity'

describe('connectivity', () => {
  beforeEach(() => { vi.useFakeTimers(); __setOnlineForTest(true); vi.runAllTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('reloads as soon as the connection is confirmed, and once more a few seconds later', () => {
    const waves: number[] = []
    const off = onReconnect(w => waves.push(w))
    __setOnlineForTest(false)
    expect(isOnline()).toBe(false)
    expect(waves).toEqual([])
    __setOnlineForTest(true)
    expect(waves).toEqual([0])
    vi.advanceTimersByTime(6000)
    expect(waves).toEqual([0, 1])
    off()
  })

  it('a connection that drops again skips the later wave', () => {
    const waves: number[] = []
    const off = onReconnect(w => waves.push(w))
    __setOnlineForTest(false)
    __setOnlineForTest(true)
    __setOnlineForTest(false)
    vi.advanceTimersByTime(6000)
    expect(waves).toEqual([0])
    off()
  })

  it('staying online, or unsubscribed, does nothing', () => {
    const reload = vi.fn()
    const off = onReconnect(reload)
    __setOnlineForTest(true)
    vi.advanceTimersByTime(6000)
    expect(reload).not.toHaveBeenCalled()
    off()
    __setOnlineForTest(false); __setOnlineForTest(true); vi.advanceTimersByTime(6000)
    expect(reload).not.toHaveBeenCalled()
  })
})
