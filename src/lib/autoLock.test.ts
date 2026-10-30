import { describe, it, expect } from 'vitest'
import { AUTO_LOCK_OPTIONS, DEFAULT_AUTO_LOCK_MINUTES, normalizeAutoLockMinutes, autoLockMs, awayPastAutoLock } from './autoLock'

describe('auto-lock policy', () => {
  it('offers bounded choices and never "never"', () => {
    expect(AUTO_LOCK_OPTIONS).toEqual([1, 5, 15, 30])
    expect(DEFAULT_AUTO_LOCK_MINUTES).toBe(15)
  })

  it('a missing or tampered stored value falls back to the default, not to no lock', () => {
    for (const bad of [undefined, null, 0, -1, 2, 999, '15', Infinity, NaN]) {
      expect(normalizeAutoLockMinutes(bad)).toBe(DEFAULT_AUTO_LOCK_MINUTES)
    }
    expect(normalizeAutoLockMinutes(5)).toBe(5)
    expect(autoLockMs(1)).toBe(60_000)
    expect(autoLockMs(undefined)).toBe(15 * 60_000)
  })

  it('time in the background locks only past the chosen time', () => {
    const hidden = 1_000_000
    expect(awayPastAutoLock(hidden, hidden + 5 * 60_000, 5)).toBe(false)
    expect(awayPastAutoLock(hidden, hidden + 5 * 60_000 + 1, 5)).toBe(true)
    expect(awayPastAutoLock(hidden, hidden + 10 * 60_000, 15)).toBe(false)
    expect(awayPastAutoLock(0, hidden, 1)).toBe(false) // never hidden
  })
})
