// lib/splits.ts - Split expense: one bill shared with friends.
//
// A split is a title + total + your own share (table `splits`). Every
// friend's share is an ordinary personal payment request linked to it
// (merchant_payment_intents.split_id): the same 💸 Payment request card in
// their chat, the same contact rule, the same passcode-confirmed payment, the
// same "Paid" / "Payment received". Creating a split moves no money - each
// person pays their own share from their own wallet.
//
// Server: supabase/migrations/20261112120000_split_expense.sql
//   split_create (all or nothing) · split_summary · split_summary_by_code ·
//   my_splits · split_remind. "Mark as received" is the request's own
//   'complete' action (merchant-pay), as for any request.

import { supabase } from './supabase'

export const SPLITS_CHANGED_EVENT = 'meshport:splits-changed'
export const MAX_SPLIT_PEOPLE = 20

// ── Share maths (in cents, so shares always add up to the bill exactly) ────
const toCents = (v: number) => Math.round(v * 100)
const fromCents = (c: number) => c / 100

/**
 * Equal shares for `people` people (you included, at index 0). Every share is
 * rounded down to the cent; the cents left over stay with you (the payer), so
 * nobody is asked for more than an equal part.
 */
export function equalShares(total: number, people: number): number[] {
  if (!(total > 0) || people < 1) return []
  const cents = toCents(total)
  const base = Math.floor(cents / people)
  const extra = cents - base * people
  return Array.from({ length: people }, (_, i) => fromCents(base + (i === 0 ? extra : 0)))
}

/** Shares from percentages (you at index 0 take the rounding cents). */
export function percentShares(total: number, percents: number[]): number[] {
  if (!(total > 0) || !percents.length) return []
  const cents = toCents(total)
  const parts = percents.map(p => Math.floor((cents * Math.max(0, p)) / 100))
  const used = parts.reduce((a, b) => a + b, 0)
  const pctSum = percents.reduce((a, b) => a + Math.max(0, b), 0)
  // Only when the percentages make 100: the leftover cents go to you.
  if (Math.abs(pctSum - 100) < 1e-9) parts[0] += cents - used
  return parts.map(fromCents)
}

/**
 * A share typed into Amounts / %: never more than what's left for it - the
 * bill (or 100%) minus everyone else's shares. Returns the text to show and
 * whether it had to be lowered. `left` is in the field's own unit ($ or %).
 */
export function capShareInput(text: string, left: number): { text: string; capped: boolean } {
  const v = Number(text)
  if (!text || !Number.isFinite(v)) return { text, capped: false }
  const max = Math.max(0, Math.floor(left * 100 + 1e-6) / 100)
  if (v <= max + 1e-9) return { text, capped: false }
  return { text: String(max), capped: true }
}

/** How far the shares are from the bill, in cents (0 = they add up). */
export function sharesGap(total: number, shares: number[]): number {
  return toCents(total) - shares.reduce((a, s) => a + toCents(s), 0)
}

// ── Server ──────────────────────────────────────────────────────────────────
export interface SplitMemberInput { username: string; userId?: string | null; amount: number }
export interface CreatedSplitRequest { code: string; orderNumber: string | null; username: string; userId: string; amount: number; note: string | null }
export interface CreatedSplit { splitId: string; requests: CreatedSplitRequest[]; notPosted: string[] }

export type SplitMemberStatus = 'pending' | 'partially_paid' | 'processing' | 'paid' | 'expired' | 'cancelled' | 'failed'
export interface SplitMember {
  id: string; code: string; userId: string | null; isMe: boolean; username: string | null; name: string | null; avatar: string | null
  amount: number; received: number; status: SplitMemberStatus
  paidAt: string | null; completedByMe: boolean; completedNote: string | null
  lastRemindedAt: string | null; createdAt: string
}
export interface SplitSummary {
  id: string; title: string; emoji: string | null; total: number; myShare: number; currency: string
  createdAt: string; isCreator: boolean; sourceTx: string | null
  creator: { userId: string | null; username: string | null; name: string | null; avatar: string | null }
  people: number; requests: number; paidCount: number; owedLeft: number
  members: SplitMember[]
}
export interface MySplitMade {
  id: string; title: string; emoji: string | null; total: number; myShare: number; createdAt: string
  requests: number; paidCount: number; owedLeft: number
  members: Array<{ username: string; name: string; avatar: string | null }>
}
export interface MySplitOwe {
  splitId: string; title: string; emoji: string | null; total: number; code: string
  amount: number; left: number; status: SplitMemberStatus; createdAt: string; paidAt: string | null
  creator: { username: string | null; name: string | null; avatar: string | null }
}

function fail(error: { message?: string } | null): void {
  if (error) throw new Error(error.message || 'Something went wrong - try again')
}
const num = (v: unknown) => Number(v) || 0

/**
 * Paid, counting the person who made the split: they paid the bill, so their
 * own share is paid from the start ("2 of 3 paid" once one friend has paid).
 */
export function paidOf(s: { requests: number; paidCount: number }): { paid: number; of: number } {
  return { paid: s.paidCount + 1, of: s.requests + 1 }
}
export const isSettled = (s: { requests: number; paidCount: number }) => s.requests > 0 && s.paidCount >= s.requests
export const memberOpen = (m: Pick<SplitMember, 'status'>) => m.status === 'pending' || m.status === 'partially_paid'

function normSummary(d: any): SplitSummary {
  return {
    ...d, total: num(d.total), myShare: num(d.myShare), owedLeft: num(d.owedLeft),
    people: num(d.people), requests: num(d.requests), paidCount: num(d.paidCount),
    creator: { userId: d.creator?.userId ?? null, username: d.creator?.username ?? null, name: d.creator?.name ?? null, avatar: d.creator?.avatar ?? null },
    members: (d.members ?? []).map((m: any) => ({ ...m, userId: m.userId ?? null, isMe: !!m.isMe, amount: num(m.amount), received: num(m.received), completedByMe: !!m.completedByMe })),
  }
}

function changed() {
  try { window.dispatchEvent(new CustomEvent(SPLITS_CHANGED_EVENT)) } catch { /* no window */ }
}

/**
 * Creates the split and every friend's request (all or nothing, on the
 * server), then posts each request into that friend's chat as the usual
 * payment request card. A card that couldn't be posted doesn't undo the split:
 * the request stands, the tracker shows it, and Remind still reaches them.
 */
export async function createSplit(p: { title: string; emoji?: string | null; total: number; myShare: number; members: SplitMemberInput[]; sourceTx?: string | null }): Promise<CreatedSplit> {
  const { data, error } = await supabase.rpc('split_create', {
    p_title: p.title.trim(), p_emoji: p.emoji || null, p_total: p.total, p_my_share: p.myShare,
    p_members: p.members.map(m => ({ username: m.username.replace(/^@/, '').replace(/\.arc$/i, ''), amount: m.amount })),
    p_source_tx: p.sourceTx || null,
  })
  fail(error)
  const requests: CreatedSplitRequest[] = ((data as any)?.requests ?? []).map((r: any) => ({ ...r, amount: num(r.amount) }))
  const splitId = String((data as any)?.splitId ?? '')
  const notPosted: string[] = []
  const [{ sendChatText }, { paymentRequestMessage }, { formatAmount }, { markPaymentRequestCreated }] = await Promise.all([
    import('./chatSend'), import('./merchantPay'), import('./utils'), import('./merchantPayBasics'),
  ])
  await Promise.all(requests.map(async r => {
    try {
      await sendChatText({ toUserId: r.userId, text: paymentRequestMessage({ code: r.code, orderNumber: r.orderNumber, amount: r.amount, note: r.note }, formatAmount(r.amount)) })
    } catch { notPosted.push(r.username) }
  }))
  markPaymentRequestCreated()
  changed()
  return { splitId, requests, notPosted }
}

export async function getSplit(id: string): Promise<SplitSummary> {
  const { data, error } = await supabase.rpc('split_summary', { p_split: id })
  fail(error)
  return normSummary(data)
}

/** The split a payment request card belongs to (null: not a split, or not yours to see). */
const byCode = new Map<string, { at: number; v: Promise<SplitSummary | null> }>()
export function splitForCode(code: string, maxAgeMs = 15_000): Promise<SplitSummary | null> {
  const hit = byCode.get(code)
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.v
  const v = Promise.resolve(supabase.rpc('split_summary_by_code', { p_code: code }))
    .then(({ data, error }) => (error || !data ? null : normSummary(data)))
    .catch(() => null)
  byCode.set(code, { at: Date.now(), v })
  return v
}

export async function mySplits(): Promise<{ made: MySplitMade[]; owe: MySplitOwe[] }> {
  const { data, error } = await supabase.rpc('my_splits')
  fail(error)
  const d = (data ?? {}) as any
  return {
    made: (d.made ?? []).map((s: any) => ({ ...s, total: num(s.total), myShare: num(s.myShare), requests: num(s.requests), paidCount: num(s.paidCount), owedLeft: num(s.owedLeft), members: s.members ?? [] })),
    owe: (d.owe ?? []).map((s: any) => ({ ...s, total: num(s.total), amount: num(s.amount), left: num(s.left) })),
  }
}

/** A notification to one person who hasn't paid yet (once every 12 hours). */
export async function remindSplitMember(intentId: string): Promise<void> {
  const { error } = await supabase.rpc('split_remind', { p_intent: intentId })
  fail(error)
  changed()
}

/** They paid you another way (cash…): their share counts as received. No payment is invented. */
export async function markSplitReceived(code: string): Promise<void> {
  const { completeOrder } = await import('./merchantPay')
  await completeOrder(code, 'Paid outside MeshPort')
  byCode.delete(code)
  changed()
}

/** "$8.33" */
export function money(v: number): string {
  return `$${(Math.round(v * 100) / 100).toFixed(2)}`
}

// ── Split groups: everyone in a split, with their own message thread ──────
export interface SplitGroup {
  id: string; title: string; emoji: string | null; total: number; isCreator: boolean
  people: number; paidCount: number; requests: number
  lastBody: string | null; lastSender: string | null; lastIsMe: boolean; at: string
}
export interface SplitMessage { id: string; split_id: string; sender_user_id: string; body: string; created_at: string }

/** Every split group you're in (made or asked in), newest activity first. */
export async function mySplitGroups(): Promise<SplitGroup[]> {
  const { data, error } = await supabase.rpc('my_split_groups')
  fail(error)
  return ((data ?? []) as any[]).map(g => ({ ...g, total: num(g.total), people: num(g.people), paidCount: num(g.paidCount), requests: num(g.requests), lastIsMe: !!g.lastIsMe }))
}

export async function splitMessages(splitId: string): Promise<SplitMessage[]> {
  const { data, error } = await supabase.from('split_messages').select('id, split_id, sender_user_id, body, created_at')
    .eq('split_id', splitId).order('created_at', { ascending: true }).limit(500)
  fail(error)
  return (data ?? []) as SplitMessage[]
}

export async function sendSplitMessage(splitId: string, body: string): Promise<SplitMessage> {
  const text = body.trim().slice(0, 1000)
  if (!text) throw new Error('Nothing to send')
  // The server checks you're in the split and sets you as the sender.
  const { data, error } = await supabase.rpc('split_send_message', { p_split: splitId, p_body: text })
  fail(error)
  changed()
  return data as SplitMessage
}

/** New messages in a group as they arrive; returns the unsubscribe. */
export function watchSplitMessages(splitId: string, onMessage: (m: SplitMessage) => void): () => void {
  const ch = supabase.channel(`split-msgs-${splitId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'split_messages', filter: `split_id=eq.${splitId}` },
      (p: { new: SplitMessage }) => onMessage(p.new))
    .subscribe()
  return () => { void supabase.removeChannel(ch) }
}

// When you last looked at each group (this device): a group with newer
// activity shows as unread in Chats.
const SEEN_KEY = 'mp_split_group_seen'
export function splitGroupSeenAt(id: string): number {
  try { return Number(JSON.parse(localStorage.getItem(SEEN_KEY) || '{}')[id]) || 0 } catch { return 0 }
}
export function markSplitGroupSeen(id: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}')
    all[id] = Date.now()
    localStorage.setItem(SEEN_KEY, JSON.stringify(all))
  } catch { /* private mode */ }
}
