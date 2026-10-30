import { describe, it, expect } from 'vitest'
import { BACKGROUND_LOCK_MS, awayPastAutoLock } from './autoLock'

describe('auto-lock policy (like UPI apps)', () => {
  it('locks after 5 minutes in the background', () => {
    expect(BACKGROUND_LOCK_MS).toBe(5 * 60_000)
  })

  it('a short switch away does not lock; longer than 5 minutes does', () => {
    const hidden = 1_000_000
    expect(awayPastAutoLock(hidden, hidden + 30_000)).toBe(false)
    expect(awayPastAutoLock(hidden, hidden + 5 * 60_000)).toBe(false)
    expect(awayPastAutoLock(hidden, hidden + 5 * 60_000 + 1)).toBe(true)
    expect(awayPastAutoLock(0, hidden)).toBe(false) // never hidden
  })
})
