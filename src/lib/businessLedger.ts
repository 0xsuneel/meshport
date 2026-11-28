// Business → Credit book (28 Nov, like Paytm's Khata): what each customer owes
// ("Gave credit") and what they've paid ("Got paid"). A pay link sent from
// here is entered for you when it's paid (ledger_enter_payment).
import { supabase } from '@/lib/supabase'

export type LedgerCustomer = { id: string; name: string; contact: string | null; username: string | null; createdAt: string }
export type LedgerEntry = { id: string; customerId: string; kind: 'credit' | 'payment'; amount: number; note: string | null; createdAt: string; fromPayLink: boolean }

const fail = (e: { message: string } | null) => { if (e) throw new Error(e.message.replace(/^.*?ERROR:\s*/, '')) }

export async function listLedger(): Promise<{ customers: LedgerCustomer[]; entries: LedgerEntry[] }> {
  if (import.meta.env.VITE_E2E === '1') {
    try { if (localStorage.getItem('meshport_e2e_business') === '1') return E2E_LEDGER } catch { /* storage off */ }
  }
  const [c, e] = await Promise.all([
    supabase.from('business_ledger_customers').select('*').order('created_at'),
    supabase.from('business_ledger_entries').select('*').order('created_at', { ascending: false }).limit(2000),
  ])
  fail(c.error); fail(e.error)
  return {
    customers: (c.data ?? []).map((r: any) => ({ id: r.id, name: r.name, contact: r.contact ?? null, username: r.username ?? null, createdAt: r.created_at })),
    entries: (e.data ?? []).map((r: any) => ({ id: r.id, customerId: r.customer_id, kind: r.kind, amount: Number(r.amount), note: r.note ?? null, createdAt: r.created_at, fromPayLink: !!r.intent_id })),
  }
}

export async function saveLedgerCustomer(c: { id?: string; name: string; contact?: string | null; username?: string | null }): Promise<LedgerCustomer> {
  const name = c.name.trim().slice(0, 80)
  if (!name) throw new Error('Add their name')
  const row = { name, contact: c.contact?.trim().slice(0, 120) || null, username: c.username?.trim().replace(/^@/, '').replace(/\.arc$/i, '').toLowerCase().slice(0, 40) || null }
  const q = c.id ? supabase.from('business_ledger_customers').update(row).eq('id', c.id) : supabase.from('business_ledger_customers').insert(row)
  const { data, error } = await q.select('*').single()
  fail(error)
  return { id: data.id, name: data.name, contact: data.contact ?? null, username: data.username ?? null, createdAt: data.created_at }
}

export async function deleteLedgerCustomer(id: string): Promise<void> {
  const { error } = await supabase.from('business_ledger_customers').delete().eq('id', id)
  fail(error)
}

export async function addLedgerEntry(customerId: string, kind: 'credit' | 'payment', amount: number, note?: string): Promise<void> {
  if (!(amount > 0)) throw new Error('Enter an amount')
  const { error } = await supabase.from('business_ledger_entries').insert({ customer_id: customerId, kind, amount: Math.round(amount * 100) / 100, note: note?.trim().slice(0, 140) || null })
  fail(error)
}

export async function deleteLedgerEntry(id: string): Promise<void> {
  const { error } = await supabase.from('business_ledger_entries').delete().eq('id', id)
  fail(error)
}

/** What a customer owes: credit given minus payments (negative = an advance you hold). */
export function ledgerBalance(entries: LedgerEntry[], customerId: string): number {
  return Math.round(entries.filter(e => e.customerId === customerId).reduce((t, e) => t + (e.kind === 'credit' ? e.amount : -e.amount), 0) * 100) / 100
}

// Test build only (VITE_E2E): a sample credit book.
const E2E_LEDGER = {
  customers: [
    { id: 'k1', name: 'Ravi Kumar', contact: '+971 50 222 1188', username: null, createdAt: '2026-11-01T00:00:00Z' },
    { id: 'k2', name: 'meera.arc', contact: null, username: 'meera', createdAt: '2026-11-02T00:00:00Z' },
    { id: 'k3', name: 'Sara', contact: null, username: null, createdAt: '2026-11-03T00:00:00Z' },
  ] as LedgerCustomer[],
  entries: [
    { id: 'x1', customerId: 'k1', kind: 'credit', amount: 42, note: 'Groceries', createdAt: new Date().toISOString(), fromPayLink: false },
    { id: 'x2', customerId: 'k1', kind: 'payment', amount: 30, note: 'Paid by MeshPort', createdAt: new Date(Date.now() - 86_400_000).toISOString(), fromPayLink: true },
    { id: 'x3', customerId: 'k1', kind: 'credit', amount: 80, note: 'Rice 10 kg, oil', createdAt: new Date(Date.now() - 4 * 86_400_000).toISOString(), fromPayLink: false },
    { id: 'x4', customerId: 'k2', kind: 'credit', amount: 54.5, note: null, createdAt: new Date().toISOString(), fromPayLink: false },
    { id: 'x5', customerId: 'k3', kind: 'payment', amount: 20, note: 'Advance for an order', createdAt: new Date().toISOString(), fromPayLink: false },
  ] as LedgerEntry[],
}

// ── Staff attendance ────────────────────────────────────────────────────────
export type Shift = { id: string; staffUid: string; counterId: string | null; checkIn: string; checkOut: string | null }

export async function listAttendance(days = 7): Promise<Shift[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const { data, error } = await supabase.from('business_attendance').select('*').gte('check_in', since).order('check_in', { ascending: false }).limit(1000)
  fail(error)
  return (data ?? []).map((r: any) => ({ id: r.id, staffUid: r.staff_auth_uid, counterId: r.counter_id ?? null, checkIn: r.check_in, checkOut: r.check_out ?? null }))
}

/** Checks in (location once, when the phone allows it - never required). */
export async function checkIn(owner: string): Promise<void> {
  const pos = await new Promise<GeolocationPosition | null>(res => {
    try { navigator.geolocation.getCurrentPosition(res, () => res(null), { timeout: 6000, maximumAge: 60_000 }) } catch { res(null) }
  })
  const { error } = await supabase.rpc('staff_check_in', { p_owner: owner, p_lat: pos?.coords.latitude ?? null, p_lng: pos?.coords.longitude ?? null })
  fail(error)
}
export async function checkOut(owner: string): Promise<void> {
  const { error } = await supabase.rpc('staff_check_out', { p_owner: owner })
  fail(error)
}
export const shiftMinutes = (s: Shift, now = Date.now()) => Math.max(0, Math.round(((s.checkOut ? Date.parse(s.checkOut) : now) - Date.parse(s.checkIn)) / 60_000))
export const hm = (min: number) => `${Math.floor(min / 60)}h ${min % 60}m`

/** Payment alerts for one staff member (payments at their counter). */
export async function setStaffAlerts(staffRowId: string, on: boolean): Promise<void> {
  const { error } = await supabase.from('business_staff').update({ payment_alerts: on }).eq('id', staffRowId)
  fail(error)
}
