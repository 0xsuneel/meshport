import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/ActivityService', () => ({
  fetchActivity: vi.fn(async (_w: string, o: { meta?: { failed?: boolean } }) => {
    if ((globalThis as any).__fail) { if (o.meta) o.meta.failed = true; return [] }
    return [{ id: 'a', walletAddress: '0xabc', activityType: 'send', amount: 1, status: 'completed', createdAt: '2026-11-11T14:19:52Z', updatedAt: '2026-11-11T14:19:52Z' }]
  }),
  subscribeToActivity: vi.fn(), resolveCounterpartyNames: vi.fn(), primeCounterpartyNames: vi.fn(), withKnownCounterpartyNames: vi.fn(),
}))
vi.mock('@/lib/onchainReceivedActivity', () => ({ fetchRecentOnchainReceived: vi.fn(async () => []) }))
vi.mock('@/lib/arcDepositWatcher', () => ({ getRecentArcDeposits: () => [] }))

import { prefetchActivity, ACTIVITY_CACHE_PREFIX } from './useActivity'

describe('prefetchActivity', () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = new Map()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
    ;(globalThis as any).__fail = false
  })
  it('saves the current first page for the next Activity open', async () => {
    await prefetchActivity('0xABC')
    const saved = JSON.parse(store.get(ACTIVITY_CACHE_PREFIX + '0xabc')!)
    expect(saved.list.map((r: { id: string }) => r.id)).toEqual(['a'])
    expect(saved.at).toBeGreaterThan(0)
  })
  it('a failed request leaves the saved list alone', async () => {
    store.set(ACTIVITY_CACHE_PREFIX + '0xabc', JSON.stringify({ at: 1, list: [{ id: 'old' }] }))
    ;(globalThis as any).__fail = true
    await prefetchActivity('0xabc')
    expect(JSON.parse(store.get(ACTIVITY_CACHE_PREFIX + '0xabc')!).list[0].id).toBe('old')
  })
  it('no wallet: nothing', async () => {
    await prefetchActivity(null)
    expect(store.size).toBe(0)
  })
})
