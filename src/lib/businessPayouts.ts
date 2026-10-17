// Business → Payouts: saved lists of people to pay (staff, suppliers), once
// or on a repeat. Sent through Bulk Pay on this device; a due payout only
// reminds the owner (business_payout_reminders).
import { supabase } from '@/lib/supabase'

export type PayoutRepeat = 'none' | 'weekly' | 'monthly'
export type PayoutRecipient = { to: string; amount: number; label?: string }
export type BusinessPayout = {
  id: string; name: string; recipients: PayoutRecipient[]; repeat: PayoutRepeat
  nextDue: string | null; lastPaidAt: string | null
}

const map = (r: any): BusinessPayout => ({
  id: r.id, name: r.name, recipients: Array.isArray(r.recipients) ? r.recipients : [], repeat: r.repeat ?? 'none',
  nextDue: r.next_due ?? null, lastPaidAt: r.last_paid_at ?? null,
})

export const payoutTotal = (p: { recipients: PayoutRecipient[] }) => p.recipients.reduce((s, r) => s + (Number(r.amount) || 0), 0)

export async function listPayouts(): Promise<BusinessPayout[]> {
  const { data, error } = await supabase.from('business_payouts').select('*').order('next_due', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []).map(map)
}

export async function savePayout(p: { id?: string; name: string; recipients: PayoutRecipient[]; repeat: PayoutRepeat; nextDue: string | null }): Promise<BusinessPayout> {
  const row = { name: p.name.trim(), recipients: p.recipients, repeat: p.repeat, next_due: p.nextDue, reminded_for: null, updated_at: new Date().toISOString() }
  const q = p.id
    ? supabase.from('business_payouts').update(row).eq('id', p.id).select('*').single()
    : supabase.from('business_payouts').insert(row).select('*').single()
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return map(data)
}

export async function deletePayout(id: string): Promise<void> {
  const { error } = await supabase.from('business_payouts').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

/** Sent: a repeating payout moves to its next date. */
export async function markPayoutPaid(id: string): Promise<void> {
  await supabase.rpc('business_payout_paid', { p_id: id })
}

/** What Bulk Pay reads from the route state to start filled in. */
export type BulkPayPrefill = { payoutId: string; purpose: string; recipients: Array<{ input: string; amount: number }> }
