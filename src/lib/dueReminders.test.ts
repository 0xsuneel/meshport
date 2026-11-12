import { describe, it, expect, beforeEach, vi } from 'vitest'
vi.mock('./supabase', () => ({ supabase: { rpc: vi.fn() } }))
const store = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, clear: () => store.clear() })
import { toDueRequest, visibleReminders, hideReminder, hiddenCodes, snoozeReminders, remindersSnoozed, REMIND_EVERY_MS, agoText, dueChip } from './dueReminders'

const W = '0xAbC'
const row = (o: Record<string, unknown> = {}) => ({ code: 'c1', orderNumber: 'ORD-100042', kind: 'bill', amount: 10, due: 10, note: ' ', items: null, dueDate: null, createdAt: '2026-11-10T10:00:00Z', fromName: '', fromUsername: 'bob.arc', fromAvatar: null, split: null, ...o })

describe('dueReminders', () => {
  beforeEach(() => localStorage.clear())

  it('maps rows and drops ones with nothing due', () => {
    const r = toDueRequest(row())!
    expect(r.kind).toBe('bill'); expect(r.note).toBeNull(); expect(r.fromName).toBe('bob.arc')
    expect(toDueRequest(row({ due: 0 }))).toBeNull()
    expect(toDueRequest(row({ kind: 'weird' }))!.kind).toBe('request')
    const s = toDueRequest(row({ kind: 'split', split: { id: 's', title: 'Dinner', emoji: '🍕', total: '25', people: 3, paid: 2 } }))!
    expect(s.split).toEqual({ id: 's', title: 'Dinner', emoji: '🍕', total: 25, people: 3, paid: 2 })
  })

  it('hides per wallet, case-insensitive', () => {
    hideReminder(W, 'c1')
    expect(hiddenCodes('0xabc').has('c1')).toBe(true)
    expect(hiddenCodes('0xdef').size).toBe(0)
    const list = [toDueRequest(row())!, toDueRequest(row({ code: 'c2' }))!]
    expect(visibleReminders(list, hiddenCodes(W)).map(r => r.code)).toEqual(['c2'])
  })

  it('close all waits 12 hours', () => {
    const t = 1_000_000_000_000
    expect(remindersSnoozed(W, t)).toBe(false)
    snoozeReminders(W, t)
    expect(remindersSnoozed(W, t + REMIND_EVERY_MS - 1)).toBe(true)
    expect(remindersSnoozed(W, t + REMIND_EVERY_MS)).toBe(false)
  })

  it('reads dates', () => {
    const now = new Date(2026, 10, 12, 15).getTime()
    expect(agoText(new Date(2026, 10, 12, 1).toISOString(), now)).toBe('today')
    expect(agoText(new Date(2026, 10, 11, 23).toISOString(), now)).toBe('yesterday')
    expect(agoText(new Date(2026, 10, 9).toISOString(), now)).toBe('3 days ago')
    expect(dueChip('2026-11-15', now)).toEqual({ text: 'Due in 3 days', late: false })
    expect(dueChip('2026-11-12', now)).toEqual({ text: 'Due today', late: false })
    expect(dueChip('2026-11-10', now)).toEqual({ text: 'Overdue by 2 days', late: true })
    expect(dueChip(null, now)).toBeNull()
  })
})
