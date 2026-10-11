import { describe, it, expect, beforeEach, vi } from 'vitest'
import { recordFailedSend, failedSendsByAddress } from './failedSends'

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  })
})

describe('failedSends', () => {
  it('keeps the latest failure per recipient, per sending wallet', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-11T10:00:00Z'))
    recordFailedSend('0xAAA', { to: '0xBob', amount: 2, token: 'USDC' })
    vi.setSystemTime(new Date('2026-10-11T11:00:00Z'))
    recordFailedSend('0xaaa', { to: '0xbob', amount: 3, token: 'USDC' })
    vi.useRealTimers()
    const m = failedSendsByAddress('0xaaa')
    expect(m.get('0xbob')).toMatchObject({ amount: 3, at: '2026-10-11T11:00:00.000Z' })
    expect(failedSendsByAddress('0xother').size).toBe(0)
  })
  it('ignores missing wallet / recipient', () => {
    recordFailedSend(null, { to: '0xbob', amount: 1, token: 'USDC' })
    recordFailedSend('0xaaa', { to: '', amount: 1, token: 'USDC' })
    expect(failedSendsByAddress('0xaaa').size).toBe(0)
  })
})
