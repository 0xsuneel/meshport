import { describe, it, expect, vi, afterEach } from 'vitest'
import { hedgedRequest, HEDGED_METHODS } from '../../api/_lib/hedgedTransport'

const later = <T,>(ms: number, v: T, fail = false) => () => new Promise<T>((res, rej) => setTimeout(() => fail ? rej(v) : res(v), ms))

describe('hedgedRequest', () => {
  afterEach(() => { vi.useRealTimers() })
  it('a hanging first RPC: the next one is asked after the hedge delay and wins', async () => {
    vi.useFakeTimers()
    const p = hedgedRequest([later(8_000, 'slow'), later(200, 'fast')], { method: 'eth_gasPrice' }, 1_200)
    await vi.advanceTimersByTimeAsync(1_500)
    await expect(p).resolves.toBe('fast')
  })
  it('a quick first answer: the others are never asked', async () => {
    vi.useFakeTimers()
    const second = vi.fn(later(10, 'b'))
    const p = hedgedRequest([later(100, 'a'), second], { method: 'eth_call' }, 1_200)
    await vi.advanceTimersByTimeAsync(200)
    await expect(p).resolves.toBe('a')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(second).not.toHaveBeenCalled()
  })
  it('a failing RPC moves on at once; all failing rejects with the last error', async () => {
    vi.useFakeTimers()
    const ok = hedgedRequest([later(10, new Error('down'), true), later(10, 'ok')], { method: 'eth_call' }, 5_000)
    await vi.advanceTimersByTimeAsync(50)
    await expect(ok).resolves.toBe('ok')
    const bad = hedgedRequest([later(10, new Error('a'), true), later(10, new Error('b'), true)], { method: 'eth_call' }, 5_000)
    const check = expect(bad).rejects.toThrow('b')
    await vi.advanceTimersByTimeAsync(50)
    await check
  })
  it('sends and nonces are never raced', () => {
    expect(HEDGED_METHODS.has('eth_sendRawTransaction')).toBe(false)
    expect(HEDGED_METHODS.has('eth_getTransactionCount')).toBe(false)
  })
})
