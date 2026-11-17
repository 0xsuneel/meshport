import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@/lib/recentContacts', () => ({ invalidateRecentContactsCache: vi.fn() }))

describe('notifyActivityChanged', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('signals at once and again after the server has written its rows', async () => {
    vi.useFakeTimers()
    const events: string[] = []
    const target = new EventTarget()
    vi.stubGlobal('window', Object.assign(target, { }))
    const { notifyActivityChanged, ACTIVITY_CHANGED_EVENT } = await import('./activityChanged')
    target.addEventListener(ACTIVITY_CHANGED_EVENT, () => events.push('x'))
    notifyActivityChanged()
    expect(events.length).toBe(1)
    vi.advanceTimersByTime(2600)
    expect(events.length).toBe(2)
    vi.advanceTimersByTime(5000)
    expect(events.length).toBe(3)
  })

  it('a second transaction restarts the follow-ups instead of doubling them', async () => {
    vi.useFakeTimers()
    const events: string[] = []
    const target = new EventTarget()
    vi.stubGlobal('window', target)
    vi.resetModules()
    const { notifyActivityChanged, ACTIVITY_CHANGED_EVENT } = await import('./activityChanged')
    target.addEventListener(ACTIVITY_CHANGED_EVENT, () => events.push('x'))
    notifyActivityChanged()
    vi.advanceTimersByTime(1000)
    notifyActivityChanged()
    vi.advanceTimersByTime(10_000)
    expect(events.length).toBe(4) // two immediate + one pair of follow-ups
  })
})
