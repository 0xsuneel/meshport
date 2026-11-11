import { describe, it, expect, beforeEach, vi } from 'vitest'
import { markBalanceRead, balanceReadAt, staleBalanceLabel, formatAge, STALE_MS } from './balanceFreshness'

describe('balanceFreshness', () => {
  beforeEach(() => {
    const m = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) }, clear: () => m.clear() })
  })
  it('nothing recorded: no label', () => {
    expect(balanceReadAt('0xAbC')).toBeNull()
    expect(staleBalanceLabel('0xAbC')).toBeNull()
  })
  it('a fresh read shows no label; an old one says how old', () => {
    const now = 1_700_000_000_000
    markBalanceRead('0xAbC', now - 30_000)
    expect(staleBalanceLabel('0xabc', now)).toBeNull()
    markBalanceRead('0xAbC', now - STALE_MS - 60_000)
    expect(staleBalanceLabel('0xABC', now)).toBe('Updated 3 min ago')
  })
  it('formats hours and days', () => {
    expect(formatAge(59_000)).toBe('1 min ago')
    expect(formatAge(3 * 3600_000)).toBe('3 h ago')
    expect(formatAge(26 * 3600_000)).toBe('1 day ago')
    expect(formatAge(5 * 86400_000)).toBe('5 days ago')
  })
  it('no address: nothing', () => {
    markBalanceRead(null)
    expect(staleBalanceLabel(undefined)).toBeNull()
  })
})
