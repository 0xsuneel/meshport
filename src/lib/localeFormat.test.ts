import { describe, it, expect } from 'vitest'
import { formatLocale } from './localeFormat'

const OPTS: Intl.DateTimeFormatOptions[] = [
  { hour: 'numeric', minute: '2-digit' },
  { month: 'short', day: 'numeric' },
  { month: 'short', day: 'numeric', year: '2-digit' },
  { weekday: 'long', month: 'short', day: 'numeric' },
  { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' },
]

describe('formatLocale', () => {
  it('matches toLocaleString / toLocaleDateString / toLocaleTimeString exactly', () => {
    for (let i = 0; i < 400; i++) {
      const d = new Date(Date.UTC(2023, 0, 1) + i * 86_400_000 * 1.37 + i * 3_917_000)
      for (const o of OPTS) {
        for (const loc of [[], 'en-US'] as const) {
          const l = loc as string | string[]
          expect(formatLocale(d, l, o)).toBe(d.toLocaleString(l, o))
          if (!('hour' in o)) expect(formatLocale(d, l, o)).toBe(d.toLocaleDateString(l, o))
          if ('hour' in o) expect(formatLocale(d, l, o)).toBe(d.toLocaleTimeString(l, o))
        }
      }
    }
  })

  it('an invalid date gives "Invalid Date" like before, instead of throwing', () => {
    const bad = new Date('not a date')
    expect(bad.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })).toBe('Invalid Date')
    expect(formatLocale(bad, [], { hour: 'numeric', minute: '2-digit' })).toBe('Invalid Date')
  })
})
