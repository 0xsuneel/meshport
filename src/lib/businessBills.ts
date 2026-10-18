// Business bills: due dates and reminders.
//
// A bill (or any order) can carry a due date. The owner taps Remind to send
// the customer an in-app notification (merchant_bill_remind: owner only, one
// per bill every 12 hours) or Remind all for one customer
// (merchant_remind_customer). A daily job also reminds on the due date and
// every 3 days while overdue (business_bill_reminders, 3 at most).
import { supabase } from './supabase'

const fail = (e: { message: string } | null) => { if (e) throw new Error(e.message.replace(/^.*?ERROR:\s*/, '')) }

/** Local calendar date as YYYY-MM-DD (not UTC). */
export const isoDay = (d: Date) => d.toLocaleDateString('en-CA')

/** Due-date presets in the bill composer. */
export const DUE_PRESETS = [
  { id: 'none', label: 'No due date', days: null },
  { id: '0', label: 'Today', days: 0 },
  { id: '7', label: '7 days', days: 7 },
  { id: '15', label: '15 days', days: 15 },
  { id: '30', label: '30 days', days: 30 },
  { id: 'custom', label: 'Custom', days: null },
] as const
export type DuePresetId = typeof DUE_PRESETS[number]['id']

/** The date a preset lands on, from `now` (local days). */
export function duePresetDate(id: DuePresetId, now = new Date()): string | null {
  const p = DUE_PRESETS.find(x => x.id === id)
  if (!p || p.days === null) return null
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + p.days)
  return isoDay(d)
}

/** Whole local days from `now` to `due` (negative = overdue). */
export function daysUntil(due: string, now = new Date()): number {
  const [y, m, d] = due.split('-').map(Number)
  const a = new Date(y, (m || 1) - 1, d || 1).getTime()
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return Math.round((a - b) / 86_400_000)
}

export type DueTone = 'neutral' | 'warning' | 'danger'

/**
 * "Due 25 Oct" / "Due today" / "Due tomorrow" / "Overdue 3 days" for an
 * order still to be paid; null without a due date or once it's settled.
 */
export function dueText(due: string | null | undefined, open: boolean, now = new Date()): { text: string; tone: DueTone; days: number } | null {
  if (!due || !open || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return null
  const days = daysUntil(due, now)
  if (days < 0) return { text: `Overdue ${-days} day${days === -1 ? '' : 's'}`, tone: 'danger', days }
  if (days === 0) return { text: 'Due today', tone: 'warning', days }
  if (days === 1) return { text: 'Due tomorrow', tone: 'warning', days }
  const [y, m, d] = due.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const label = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(y !== now.getFullYear() ? { year: 'numeric' } : {}) })
  return { text: `Due ${label}`, tone: 'neutral', days }
}

const REMIND_GAP_MS = 12 * 3_600_000
/** Remind can be tapped again (12 hours after the last reminder). */
export function canRemindAt(lastRemindedAt: string | null | undefined, now = Date.now()): { ok: boolean; inHours: number } {
  if (!lastRemindedAt) return { ok: true, inHours: 0 }
  const left = Date.parse(lastRemindedAt) + REMIND_GAP_MS - now
  return left <= 0 ? { ok: true, inHours: 0 } : { ok: false, inHours: Math.max(1, Math.ceil(left / 3_600_000)) }
}

/** Send the customer a reminder for one open bill. */
export async function remindBill(intentId: string): Promise<void> {
  const { error } = await supabase.rpc('merchant_bill_remind', { p_intent: intentId })
  fail(error)
}

/** One reminder for all of a customer's open bills; returns how many bills it covered. */
export async function remindCustomer(username: string): Promise<number> {
  const { data, error } = await supabase.rpc('merchant_remind_customer', { p_username: username })
  fail(error)
  return Number(data) || 0
}

/** Set (or clear) the due date of an open bill - owner, or the staff who made it. */
export async function setDueDate(intentId: string, due: string | null): Promise<void> {
  const { error } = await supabase.rpc('merchant_set_due_date', { p_intent: intentId, p_due: due })
  fail(error)
}
