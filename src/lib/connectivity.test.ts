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

import { whenNetworkOk, isSlowNetwork, noteRequestTime, __setSlowForTest } from './connectivity'

describe('slow network', () => {
  it('holds extras back while slow and runs them once it is better', () => {
    __setOnlineForTest(true); __setSlowForTest(true)
    const fn = vi.fn()
    whenNetworkOk(fn)
    expect(fn).not.toHaveBeenCalled()
    __setSlowForTest(false)
    expect(fn).toHaveBeenCalledTimes(1)
    whenNetworkOk(fn) // normal network: at once
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('a cancelled wait never runs; a very slow request switches slow mode on', () => {
    __setSlowForTest(true)
    const fn = vi.fn()
    whenNetworkOk(fn)()
    __setSlowForTest(false)
    expect(fn).not.toHaveBeenCalled()
    noteRequestTime(2000); expect(isSlowNetwork()).toBe(false)
    noteRequestTime(9000); expect(isSlowNetwork()).toBe(true)
    __setSlowForTest(false)
  })
})
