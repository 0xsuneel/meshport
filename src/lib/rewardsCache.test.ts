import { describe, it, expect, beforeEach, vi } from 'vitest'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })

import { readRewardsCache, writeRewardsCache, REWARDS_CACHE_PREFIX, utcDay } from './rewardsCache'

const snap = { totalPoints: 120, lifetimePoints: 900, claims: [{ id: 'c1' }], history: [{ id: 'p1' }, { id: 'p2' }], dailyClaimed: 300 }

describe('rewardsCache', () => {
  beforeEach(() => store.clear())

  it('round-trips the last loaded Rewards data, per account', () => {
    const t = Date.UTC(2026, 10, 10, 9)
    writeRewardsCache('u1', snap, t)
    expect(readRewardsCache('u1', t)).toMatchObject({ ...snap, at: t })
    expect(readRewardsCache('u2', t)).toBeNull()
  })

  it("today's claimed amount only counts on the same UTC day", () => {
    const t = Date.UTC(2026, 10, 10, 23, 30)
    writeRewardsCache('u1', snap, t)
    expect(readRewardsCache('u1', t + 40 * 60_000)?.dailyClaimed).toBe(0) // past midnight UTC
    expect(readRewardsCache('u1', t + 40 * 60_000)?.totalPoints).toBe(120) // the rest still shows
    expect(utcDay(t)).toBe('2026-11-10')
  })

  it('keeps the lists short', () => {
    writeRewardsCache('u1', { ...snap, claims: Array.from({ length: 80 }, (_, i) => ({ i })), history: Array.from({ length: 300 }, (_, i) => ({ i })) })
    const r = readRewardsCache('u1')!
    expect(r.claims.length).toBe(20)
    expect(r.history.length).toBe(50)
  })

  it('ignores broken or foreign data instead of throwing', () => {
    store.set(REWARDS_CACHE_PREFIX + 'u1', '{not json')
    expect(readRewardsCache('u1')).toBeNull()
    store.set(REWARDS_CACHE_PREFIX + 'u1', JSON.stringify({ v: 99, totalPoints: 1, claims: [], history: [] }))
    expect(readRewardsCache('u1')).toBeNull()
    expect(readRewardsCache('')).toBeNull()
  })
})
