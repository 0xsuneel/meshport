import { describe, it, expect } from 'vitest'
import { dueText, duePresetDate, daysUntil, canRemindAt } from './businessBills'

const now = new Date(2026, 9, 18, 15, 30) // 18 Oct 2026, 3:30 PM local

describe('dueText', () => {
  it('is empty without a due date or once settled', () => {
    expect(dueText(null, true, now)).toBeNull()
    expect(dueText('2026-10-25', false, now)).toBeNull()
    expect(dueText('not-a-date', true, now)).toBeNull()
  })
  it('names today, tomorrow and later days', () => {
    expect(dueText('2026-10-18', true, now)).toMatchObject({ text: 'Due today', tone: 'warning', days: 0 })
    expect(dueText('2026-10-19', true, now)).toMatchObject({ text: 'Due tomorrow', days: 1 })
    expect(dueText('2026-10-25', true, now)).toMatchObject({ text: 'Due 25 Oct', tone: 'neutral', days: 7 })
  })
  it('adds the year for another year', () => {
    expect(dueText('2027-01-05', true, now)?.text).toBe('Due 5 Jan 2027')
  })
  it('counts overdue days', () => {
    expect(dueText('2026-10-17', true, now)).toMatchObject({ text: 'Overdue 1 day', tone: 'danger', days: -1 })
    expect(dueText('2026-10-15', true, now)?.text).toBe('Overdue 3 days')
  })
})

describe('duePresetDate', () => {
  it('lands on local calendar days', () => {
    expect(duePresetDate('0', now)).toBe('2026-10-18')
    expect(duePresetDate('7', now)).toBe('2026-10-25')
    expect(duePresetDate('15', now)).toBe('2026-11-02')
    expect(duePresetDate('30', now)).toBe('2026-11-17')
    expect(duePresetDate('none', now)).toBeNull()
    expect(duePresetDate('custom', now)).toBeNull()
  })
  it('round-trips with daysUntil', () => {
    expect(daysUntil(duePresetDate('30', now)!, now)).toBe(30)
  })
})

describe('canRemindAt', () => {
  const t = Date.parse('2026-10-18T12:00:00Z')
  it('allows a first reminder', () => expect(canRemindAt(null, t)).toEqual({ ok: true, inHours: 0 }))
  it('waits 12 hours between reminders', () => {
    expect(canRemindAt('2026-10-18T10:00:00Z', t)).toEqual({ ok: false, inHours: 10 })
    expect(canRemindAt('2026-10-17T23:59:00Z', t)).toEqual({ ok: true, inHours: 0 })
  })
})
