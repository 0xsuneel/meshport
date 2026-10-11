import { describe, it, expect } from 'vitest'
import { expiryText } from './merchantPay'

describe('expiryText', () => {
  const now = new Date('2026-10-11T10:00:00').getTime()
  it('no expiry', () => { expect(expiryText(null, now)).toBeNull() })
  it('later today shows the time only', () => {
    expect(expiryText(new Date('2026-10-11T11:30:00').toISOString(), now)).toBe('Expires 11:30 AM')
  })
  it('another day shows the date', () => {
    expect(expiryText(new Date('2026-10-12T09:05:00').toISOString(), now)).toBe('Expires Oct 12, 9:05 AM')
  })
  it('past', () => { expect(expiryText(new Date('2026-10-11T09:00:00').toISOString(), now)).toBe('Expired') })
})
