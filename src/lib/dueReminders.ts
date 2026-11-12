// lib/dueReminders.ts - the payment-reminder popup on Home: bills, payment
// requests and Split Expense shares waiting for this person to pay.
//
// Server: supabase/migrations/20261112160000_due_reminders.sql
//   my_due_requests() - read-only; paying is the request's own payment
//   (getPayment(code) → orderPaySendUrl → the normal passcode-confirmed pay).
//
// "Hide reminder" hides one item from the popup for good (it stays payable
// in chat and Activity). "Close all" keeps those items away for 12 hours;
// something new that arrives meanwhile still shows (on its own).
// Both are this device's choice, per wallet.

import { supabase } from './supabase'
import type { InvoiceItem } from './merchantPay'

export type DueKind = 'split' | 'bill' | 'request'
export type DueRequest = {
  code: string
  orderNumber: string | null
  kind: DueKind
  amount: number
  due: number
  note: string | null
  items: InvoiceItem[] | null
  dueDate: string | null
  createdAt: string
  fromName: string
  fromUsername: string | null
  fromAvatar: string | null
  split: { id: string; title: string; emoji: string | null; total: number; people: number; paid: number } | null
}

export const REMIND_EVERY_MS = 12 * 60 * 60 * 1000
const HIDDEN_MAX = 200

const key = (wallet: string, what: string) => `mp:dueReminders:${what}:${wallet.toLowerCase()}`
function read(k: string): string | null { try { return localStorage.getItem(k) } catch { return null } }
function write(k: string, v: string) { try { localStorage.setItem(k, v) } catch { /* storage blocked */ } }

export function hiddenCodes(wallet: string): Set<string> {
  try {
    const v = JSON.parse(read(key(wallet, 'hidden')) || '[]')
    return new Set(Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : [])
  } catch { return new Set() }
}
export function hideReminder(wallet: string, code: string) {
  const list = [...hiddenCodes(wallet)].filter(c => c !== code)
  list.push(code)
  write(key(wallet, 'hidden'), JSON.stringify(list.slice(-HIDDEN_MAX)))
}
/** Items the popup has already shown on this device. */
export function seenCodes(wallet: string): Set<string> {
  try {
    const v = JSON.parse(read(key(wallet, 'seen')) || '[]')
    return new Set(Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : [])
  } catch { return new Set() }
}
/** The popup showed (or "Close all"): these items wait 12 h before showing again. */
export function snoozeReminders(wallet: string, codes: string[] = [], now = Date.now()) {
  write(key(wallet, 'closed'), String(now))
  if (!codes.length) return
  const list = [...seenCodes(wallet)].filter(c => !codes.includes(c))
  write(key(wallet, 'seen'), JSON.stringify([...list, ...codes].slice(-HIDDEN_MAX)))
}
export function remindersSnoozed(wallet: string, now = Date.now()): boolean {
  const t = Number(read(key(wallet, 'closed')) || 0)
  return t > 0 && now - t < REMIND_EVERY_MS && t <= now
}
/** What the popup shows now: not hidden; within the 12 h wait, only items
 *  that arrived since it last showed (a new bill doesn't wait half a day). */
export function remindersToShow(list: DueRequest[], wallet: string, now = Date.now()): DueRequest[] {
  const shown = visibleReminders(list, hiddenCodes(wallet))
  if (!remindersSnoozed(wallet, now)) return shown
  const seen = seenCodes(wallet)
  return shown.filter(r => !seen.has(r.code))
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
/** One row from my_due_requests → a DueRequest (null when unusable). */
export function toDueRequest(r: Record<string, unknown>): DueRequest | null {
  if (!r || typeof r.code !== 'string') return null
  const due = num(r.due)
  if (due <= 0) return null
  const kind: DueKind = r.kind === 'split' || r.kind === 'bill' ? r.kind : 'request'
  const s = r.split as Record<string, unknown> | null
  return {
    code: r.code, orderNumber: (r.orderNumber as string) ?? null, kind,
    amount: num(r.amount), due,
    note: typeof r.note === 'string' && r.note.trim() ? r.note.trim() : null,
    items: Array.isArray(r.items) ? (r.items as InvoiceItem[]) : null,
    dueDate: (r.dueDate as string) ?? null, createdAt: String(r.createdAt ?? ''),
    fromName: String(r.fromName || r.fromUsername || 'Someone'),
    fromUsername: (r.fromUsername as string) ?? null, fromAvatar: (r.fromAvatar as string) ?? null,
    split: kind === 'split' && s ? {
      id: String(s.id), title: String(s.title ?? ''), emoji: (s.emoji as string) ?? null,
      total: num(s.total), people: num(s.people), paid: num(s.paid),
    } : null,
  }
}

export async function fetchDueRequests(): Promise<DueRequest[]> {
  const { data, error } = await supabase.rpc('my_due_requests')
  if (error) throw error
  return (Array.isArray(data) ? data : []).map(r => toDueRequest(r as Record<string, unknown>)).filter((r): r is DueRequest => !!r)
}

/** What the popup shows: not hidden on this device. */
export function visibleReminders(list: DueRequest[], hidden: Set<string>): DueRequest[] {
  return list.filter(r => !hidden.has(r.code))
}

const DAY = 86_400_000
function startOfDay(t: number) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
/** "today" / "yesterday" / "3 days ago" / "on 2 Nov". */
export function agoText(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const days = Math.round((startOfDay(now) - startOfDay(t)) / DAY)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return 'on ' + new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
/** The due-date chip: "Due today" / "Due in 3 days" / "Overdue by 2 days". */
export function dueChip(dueDate: string | null, now = Date.now()): { text: string; late: boolean } | null {
  if (!dueDate) return null
  const t = Date.parse(dueDate.length <= 10 ? dueDate + 'T00:00:00' : dueDate)
  if (!Number.isFinite(t)) return null
  const days = Math.round((startOfDay(t) - startOfDay(now)) / DAY)
  if (days === 0) return { text: 'Due today', late: false }
  if (days > 0) return { text: days === 1 ? 'Due tomorrow' : `Due in ${days} days`, late: false }
  const n = -days
  return { text: `Overdue by ${n} day${n === 1 ? '' : 's'}`, late: true }
}
