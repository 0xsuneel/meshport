import { describe, it, expect } from 'vitest'
import { sortCustomers, repeatCount } from './customerSort'

const c = (key: string, total: number, last: string, visits: number) => ({ key, total, last, visits })
const list = [
  c('ravi', 50, '2026-11-10T10:00:00Z', 5),
  c('anu', 120, '2026-11-12T10:00:00Z', 2),
  c('kim', 20, '2026-11-13T09:00:00Z', 1),
  c('dev', 20, '2026-11-01T09:00:00Z', 5),
]
const owed: Record<string, number> = { kim: 30 }
const keys = (by: Parameters<typeof sortCustomers>[1]) => sortCustomers(list, by, k => owed[k] ?? 0).map(x => x.key)

describe('sortCustomers', () => {
  it('owes you: who owes most first, then who spent most', () => {
    expect(keys('owed')).toEqual(['kim', 'anu', 'ravi', 'dev'])
  })
  it('top spent, recent, most visits', () => {
    expect(keys('spent')).toEqual(['anu', 'ravi', 'dev', 'kim'])
    expect(keys('recent')).toEqual(['kim', 'anu', 'ravi', 'dev'])
    expect(keys('visits')).toEqual(['ravi', 'dev', 'anu', 'kim'])
  })
  it('does not change the list it was given', () => {
    const before = list.map(x => x.key)
    sortCustomers(list, 'spent', () => 0)
    expect(list.map(x => x.key)).toEqual(before)
  })
})

describe('repeatCount', () => {
  it('counts customers who paid more than once', () => {
    expect(repeatCount(list)).toBe(3)
  })
})
