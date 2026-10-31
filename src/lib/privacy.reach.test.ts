import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The "may I pay them" check never holds a payment up: answers are reused,
// one in flight is shared, and a payment waits at most a short time.
const rpc = vi.hoisted(() => ({ impl: null as null | (() => Promise<{ data: unknown; error: unknown }>), calls: 0 }))
vi.mock('@/lib/supabase', () => ({
  supabase: { rpc: () => { rpc.calls++; return rpc.impl!() }, from: () => ({}) },
}))

import { reachCheck, resetReachCache, PAYMENT_REACH_WAIT_MS } from './privacy'

const ALLOW = { can_pay: true, to_requests: false, blocked: false, can_request: true }
const DENY = { can_pay: false, to_requests: false, blocked: false, can_request: true }

beforeEach(() => { resetReachCache(); rpc.calls = 0; rpc.impl = async () => ({ data: [ALLOW], error: null }) })
afterEach(() => vi.useRealTimers())

describe('reachCheck', () => {
  it('a real answer is reused for a minute (the pick-time check serves the payment)', async () => {
    rpc.impl = async () => ({ data: [DENY], error: null })
    expect((await reachCheck('r1')).canPay).toBe(false)
    expect((await reachCheck('r1', { maxWaitMs: PAYMENT_REACH_WAIT_MS })).canPay).toBe(false)
    expect(rpc.calls).toBe(1)
  })

  it('two checks at once share one request', async () => {
    await Promise.all([reachCheck('r2'), reachCheck('r2'), reachCheck('r2', { maxWaitMs: 1000 })])
    expect(rpc.calls).toBe(1)
  })

  it('a payment waits at most maxWaitMs, then goes on (fails open, like a failed check)', async () => {
    vi.useFakeTimers()
    let answer!: (v: { data: unknown; error: unknown }) => void
    rpc.impl = () => new Promise(r => { answer = r })
    let got: { canPay: boolean } | null = null
    void reachCheck('r3', { maxWaitMs: 1500 }).then(v => { got = v })
    await vi.advanceTimersByTimeAsync(1499)
    expect(got).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(got).toMatchObject({ canPay: true })
    // The late answer still lands, for the next check.
    answer({ data: [DENY], error: null })
    await vi.advanceTimersByTimeAsync(0)
    expect((await reachCheck('r3')).canPay).toBe(false)
    expect(rpc.calls).toBe(1)
  })

  it('a failed check is not remembered', async () => {
    rpc.impl = async () => ({ data: null, error: { message: 'down' } })
    expect((await reachCheck('r4')).canPay).toBe(true)
    rpc.impl = async () => ({ data: [DENY], error: null })
    expect((await reachCheck('r4')).canPay).toBe(false)
  })
})
