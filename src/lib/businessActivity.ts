// Business → Activity log: who did what, owner and staff.
//
// Written by the database (charges and bills, refunds, staff and store
// changes - see 20261018120300_business_activity_triggers.sql) and by the
// app through business_log() for actions the database can't attribute
// (cancel, mark completed, settle, payout paid, limits, reminders). The
// owner reads their own rows; staff can only write to their business's log.
import { supabase } from './supabase'

export type ActivityAction =
  | 'charge_created' | 'bill_created' | 'order_cancelled' | 'order_reopened' | 'order_completed' | 'refund_sent'
  | 'settle_run' | 'payout_paid' | 'staff_invited' | 'staff_removed' | 'staff_left' | 'staff_joined' | 'staff_role_changed'
  | 'store_added' | 'store_edited' | 'store_removed' | 'limits_changed' | 'reminder_sent' | 'due_date_set'

export type ActivityRow = {
  id: string; actorAuthUid: string | null; actorUsername: string | null; action: string; target: string | null
  amount: number | null; meta: Record<string, unknown>; createdAt: string
}

/** How each action reads in the log ("Ravi created bill ORD-00012"). */
export const ACTION_LABEL: Record<ActivityAction, string> = {
  charge_created: 'Created a request',
  bill_created: 'Created a bill',
  order_cancelled: 'Cancelled',
  order_reopened: 'Reopened',
  order_completed: 'Marked completed',
  refund_sent: 'Sent a refund',
  settle_run: 'Settled to Arc',
  payout_paid: 'Paid a payout',
  staff_invited: 'Invited staff',
  staff_removed: 'Removed staff',
  staff_left: 'Left the team',
  staff_joined: 'Joined the team',
  staff_role_changed: 'Changed staff role',
  store_added: 'Added',
  store_edited: 'Edited',
  store_removed: 'Removed',
  limits_changed: 'Changed payment limits',
  reminder_sent: 'Sent a reminder',
  due_date_set: 'Set a due date',
}
export const actionLabel = (a: string) => (ACTION_LABEL as Record<string, string>)[a] ?? a.replace(/_/g, ' ')

async function myUid(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.user?.id ?? null
}

/**
 * Record one action. `owner` = the business (omit for the signed-in owner;
 * staff pass their owner's id). Never throws - logging must not block work.
 */
export async function logBusiness(action: ActivityAction, p: { owner?: string | null; target?: string | null; amount?: number | null; meta?: Record<string, unknown> } = {}): Promise<void> {
  try {
    const owner = p.owner ?? await myUid()
    if (!owner) return
    await supabase.rpc('business_log', {
      p_owner: owner, p_action: action, p_target: p.target ?? null,
      p_amount: p.amount != null && Number.isFinite(p.amount) ? Number(p.amount.toFixed(6)) : null, p_meta: p.meta ?? null,
    })
  } catch { /* best effort */ }
}

export const ACTIVITY_PAGE = 30

/** Newest first; filter by person (actor auth uid) and local day (YYYY-MM-DD). */
export async function listActivity(p: { actor?: string | null; day?: string | null; page?: number } = {}): Promise<{ rows: ActivityRow[]; more: boolean }> {
  const uid = await myUid()
  if (!uid) return { rows: [], more: false }
  const page = p.page ?? 0
  let q = supabase.from('business_activity_log').select('*').eq('owner_auth_uid', uid)
  if (p.actor) q = q.eq('actor_auth_uid', p.actor)
  if (p.day) {
    const [y, m, d] = p.day.split('-').map(Number)
    const from = new Date(y, m - 1, d), to = new Date(y, m - 1, d + 1)
    q = q.gte('created_at', from.toISOString()).lt('created_at', to.toISOString())
  }
  const { data, error } = await q.order('created_at', { ascending: false }).range(page * ACTIVITY_PAGE, page * ACTIVITY_PAGE + ACTIVITY_PAGE)
  if (error) throw new Error(error.message)
  const rows = (data ?? []).map((r: any): ActivityRow => ({
    id: r.id, actorAuthUid: r.actor_auth_uid ?? null, actorUsername: r.actor_username ?? null, action: r.action, target: r.target ?? null,
    amount: r.amount == null ? null : Number(r.amount), meta: r.meta && typeof r.meta === 'object' ? r.meta : {}, createdAt: r.created_at,
  }))
  return { rows: rows.slice(0, ACTIVITY_PAGE), more: rows.length > ACTIVITY_PAGE }
}

/** Everyone who appears in the log (for the person filter). */
export async function listActivityPeople(): Promise<Array<{ id: string; username: string | null }>> {
  const uid = await myUid()
  if (!uid) return []
  const { data } = await supabase.from('business_activity_log').select('actor_auth_uid, actor_username').eq('owner_auth_uid', uid)
    .order('created_at', { ascending: false }).limit(500)
  const seen = new Map<string, string | null>()
  for (const r of data ?? []) if (r.actor_auth_uid && !seen.has(r.actor_auth_uid)) seen.set(r.actor_auth_uid, r.actor_username ?? null)
  return [...seen].map(([id, username]) => ({ id, username }))
}
