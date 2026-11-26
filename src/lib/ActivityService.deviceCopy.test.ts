// The device copy of a wallet's activity (docs/SUPABASE_LIGHT_PLAN.md,
// Phase 2): one full read, then only rows changed since; reads in between
// answered on the device with the same filters/order/paging as the REST query.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key')

let svc: typeof import('./ActivityService')
beforeAll(async () => { svc = await import('./ActivityService') })

const W = '0xabc'
function row(id: string, created: string, extra: Record<string, unknown> = {}) {
  return { id, wallet_address: W, activity_type: 'send', status: 'completed', amount: 1, created_at: created, updated_at: created, metadata: {}, tx_hash: 'h' + id, ...extra }
}
function mockFetch(answers: unknown[][]) {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(String(url))
    const rows = answers.length > 1 ? answers.shift()! : answers[0]
    return { ok: true, status: 200, json: async () => rows, text: async () => '' }
  }))
  return urls
}

beforeEach(() => { svc.resetActivityMirror(); svc.setActivityMirrorEnabled(true) })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('activity device copy', () => {
  it('reads the wallet once, then answers repeat reads on the device', async () => {
    const urls = mockFetch([[row('a', '2026-11-26T06:00:00+00:00'), row('b', '2026-11-26T07:00:00+00:00')]])
    const first = await svc.fetchActivity(W, { limit: 10 })
    const second = await svc.fetchActivity(W, { limit: 10, activityType: 'send' })
    expect(urls.filter(u => u.includes('/rest/v1/activity'))).toHaveLength(1)
    expect(urls[0]).toContain('order=updated_at.desc')
    expect(first.map(r => r.id)).toEqual(['b', 'a'])
    expect(second.map(r => r.id)).toEqual(['b', 'a'])
  })

  it('after the fresh window asks only for rows changed since the newest one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-26T08:00:00Z'))
    const urls = mockFetch([[row('a', '2026-11-26T06:00:00+00:00')], [row('c', '2026-11-26T07:59:00+00:00')]])
    await svc.fetchActivity(W, { limit: 10 })
    vi.setSystemTime(new Date('2026-11-26T08:00:30Z'))
    const recs = await svc.fetchActivity(W, { limit: 10 })
    const delta = urls.filter(u => u.includes('/rest/v1/activity'))[1]
    expect(delta).toContain('updated_at=gt.')
    expect(delta).toContain('order=updated_at.asc')
    expect(recs.map(r => r.id)).toEqual(['c', 'a'])
  })

  it('a write on this device makes the next read fetch what changed', async () => {
    const urls = mockFetch([[row('a', '2026-11-26T06:00:00+00:00')]])
    await svc.fetchActivity(W, { limit: 10 })
    svc.invalidateActivityMirror(W)
    await svc.fetchActivity(W, { limit: 10 })
    expect(urls.filter(u => u.includes('/rest/v1/activity'))).toHaveLength(2)
  })

  it('live events update the copy without a request', async () => {
    const urls = mockFetch([[row('a', '2026-11-26T06:00:00+00:00')]])
    await svc.fetchActivity(W, { limit: 10 })
    svc.mirrorActivityRow(row('z', '2026-11-26T09:00:00+00:00', { activity_type: 'receive' }))
    const recs = await svc.fetchActivity(W, { limit: 10 })
    expect(urls.filter(u => u.includes('/rest/v1/activity'))).toHaveLength(1)
    expect(recs.map(r => r.id)).toEqual(['z', 'a'])
  })

  it('applies type, since, pending-bridge and cursor rules like the REST query', async () => {
    mockFetch([[
      row('1', '2026-11-26T01:00:00.5+00:00'),
      row('2', '2026-11-26T01:00:00.123456+00:00'),
      row('3', '2026-11-26T02:00:00+00:00', { activity_type: 'bridge', status: 'pending' }),
      row('4', '2026-11-26T03:00:00+00:00', { activity_type: 'claim', status: 'pending', metadata: { ub_recovery: true } }),
      row('5', '2026-11-26T04:00:00+00:00', { activity_type: 'withdraw', status: 'completed' }),
      row('6', '2026-11-26T01:00:00.5+00:00'),
    ]])
    const all = await svc.fetchActivity(W, { limit: 50 })
    // pending bridge (3) hidden; recovery (4) kept; ties on created_at ordered by id desc
    expect(all.map(r => r.id)).toEqual(['5', '4', '6', '1', '2'])
    const withPending = await svc.fetchActivity(W, { limit: 50, activityType: 'bridge', includePendingBridge: true })
    expect(withPending.map(r => r.id)).toEqual(['5', '4', '3'])
    const since = await svc.fetchActivity(W, { limit: 50, since: '2026-11-26T01:00:00.200000+00:00' })
    expect(since.map(r => r.id)).toEqual(['5', '4', '6', '1'])
    const page2 = await svc.fetchActivity(W, { limit: 2, cursorCreatedAt: '2026-11-26T01:00:00.5+00:00', cursorId: '6' })
    expect(page2.map(r => r.id)).toEqual(['1', '2'])
    const offset = await svc.fetchActivity(W, { limit: 2, offset: 1 })
    expect(offset.map(r => r.id)).toEqual(['4', '6'])
  })

  it('a wallet too big for the device, or a text search, still asks the server', async () => {
    const big = Array.from({ length: 801 }, (_, i) => row('r' + String(i).padStart(4, '0'), '2026-11-26T06:00:00+00:00'))
    const urls = mockFetch([big, []])
    await svc.fetchActivity(W, { limit: 20 })
    const reads = urls.filter(u => u.includes('/rest/v1/activity'))
    expect(reads).toHaveLength(2)
    expect(reads[1]).toContain('order=created_at.desc,id.desc')
  })
})
