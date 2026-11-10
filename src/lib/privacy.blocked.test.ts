import { describe, it, expect, vi, beforeEach } from 'vitest'

// chat_blocks / users reads: count them, and control each answer.
const q = { calls: 0, impl: null as null | ((table: string) => Promise<{ data: any; error: any }>) }
vi.mock('@/lib/supabase', () => {
  const chain = (table: string): any => {
    const c: any = { select: () => c, eq: () => c, in: () => c, then: (res: any, rej: any) => { q.calls++; return q.impl!(table).then(res, rej) } }
    return c
  }
  return { supabase: { from: (t: string) => chain(t), rpc: () => Promise.resolve({ data: null, error: null }) } }
})

import { blockedWalletMap, clearBlockedCache } from './privacy'

describe('blockedWalletMap', () => {
  beforeEach(() => { clearBlockedCache(); q.calls = 0 })

  it('callers asking at the same time share one lookup', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    q.impl = async (t) => { await gate; return t === 'chat_blocks' ? { data: [{ blocked_id: 'u2', created_at: '2026-01-01T00:00:00Z' }], error: null } : { data: [{ id: 'u2', wallet_address: '0xABC' }], error: null } }
    const all = Promise.all(Array.from({ length: 10 }, () => blockedWalletMap('me')))
    release()
    const maps = await all
    expect(new Set(maps).size).toBe(1)
    expect(maps[0].has('0xabc')).toBe(true)
    expect(q.calls).toBe(2) // one chat_blocks read + one users read - not 10 of each
    await blockedWalletMap('me')
    expect(q.calls).toBe(2) // cached for a minute after success
  })

  it('a failed read is not remembered as "nobody is blocked"', async () => {
    q.impl = async () => ({ data: null, error: { message: 'network' } })
    await expect(blockedWalletMap('me')).rejects.toBeTruthy()
    q.impl = async (t) => t === 'chat_blocks' ? { data: [{ blocked_id: 'u2', created_at: '2026-01-01T00:00:00Z' }], error: null } : { data: [{ id: 'u2', wallet_address: '0xabc' }], error: null }
    expect((await blockedWalletMap('me')).has('0xabc')).toBe(true)
  })

  it('blocking someone mid-lookup: the stale answer is not cached', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    q.impl = async () => { await gate; return { data: [], error: null } }
    const first = blockedWalletMap('me')
    clearBlockedCache() // blockUser / unblockUser
    release(); await first
    q.impl = async (t) => t === 'chat_blocks' ? { data: [{ blocked_id: 'u9', created_at: '2026-01-01T00:00:00Z' }], error: null } : { data: [{ id: 'u9', wallet_address: '0x99' }], error: null }
    expect((await blockedWalletMap('me')).has('0x99')).toBe(true)
  })
})
