// Business → Counters (28 Nov, like Paytm): each counter has its own Shop QR
// (/paylink/<shop>?counter=<id>) and payments on it are tagged with it.
// Payment links: a product or a fixed price (or any amount), paid once or
// many times at /l/<shop>/<slug>.
import { supabase } from '@/lib/supabase'

export type Counter = { id: string; name: string; storeId: string | null; staffUids: string[]; createdAt: string }

const fail = (e: { message: string } | null) => { if (e) throw new Error(e.message.replace(/^.*?ERROR:\s*/, '')) }
const mapCounter = (r: any): Counter => ({ id: r.id, name: r.name, storeId: r.store_id ?? null, staffUids: r.staff_uids ?? [], createdAt: r.created_at })

export async function listCounters(): Promise<Counter[]> {
  if (import.meta.env.VITE_E2E === '1') {
    try { if (localStorage.getItem('meshport_e2e_business') === '1') return E2E_COUNTERS } catch { /* storage off */ }
  }
  const { data, error } = await supabase.from('business_counters').select('*').order('created_at')
  fail(error)
  return (data ?? []).map(mapCounter)
}

export async function saveCounter(c: { id?: string; name: string; storeId: string | null; staffUids: string[] }): Promise<Counter> {
  const name = c.name.trim().slice(0, 40)
  if (!name) throw new Error('Name the counter')
  const row = { name, store_id: c.storeId, staff_uids: c.staffUids }
  const q = c.id ? supabase.from('business_counters').update(row).eq('id', c.id) : supabase.from('business_counters').insert(row)
  const { data, error } = await q.select('*').single()
  fail(error)
  return mapCounter(data)
}

export async function deleteCounter(id: string): Promise<void> {
  const { error } = await supabase.from('business_counters').delete().eq('id', id)
  fail(error)
}

/** The counter's own Shop QR link. */
export function counterQrUrl(origin: string, handle: string, c: Pick<Counter, 'id' | 'storeId'>): string {
  const u = new URL(`${origin}/paylink/${handle.replace(/\.arc$/i, '')}`)
  if (c.storeId) u.searchParams.set('store', c.storeId)
  u.searchParams.set('counter', c.id)
  return u.toString()
}

// ── Payment links ──────────────────────────────────────────────────────────
export type PayLink = {
  id: string; slug: string; title: string; description: string | null
  /** null = the customer enters the amount. */
  amount: number | null
  multi: boolean; askContact: boolean; counterId: string | null; storeId: string | null; active: boolean; createdAt: string
}
const mapLink = (r: any): PayLink => ({
  id: r.id, slug: r.slug, title: r.title, description: r.description ?? null, amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
  multi: !!r.multi, askContact: !!r.ask_contact, counterId: r.counter_id ?? null, storeId: r.store_id ?? null, active: !!r.active, createdAt: r.created_at,
})

/** "Weekly veg box!" → "weekly-veg-box" (2-40 letters, digits and dashes). */
export function linkSlug(title: string): string {
  const s = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36)
  return s.length >= 2 ? s : `link-${Math.random().toString(36).slice(2, 7)}`
}

export async function listPayLinks(): Promise<PayLink[]> {
  if (import.meta.env.VITE_E2E === '1') {
    try { if (localStorage.getItem('meshport_e2e_business') === '1') return E2E_LINKS } catch { /* storage off */ }
  }
  const { data, error } = await supabase.from('business_pay_links').select('*').order('created_at', { ascending: false })
  fail(error)
  return (data ?? []).map(mapLink)
}

export async function savePayLink(l: { id?: string; title: string; description?: string | null; amount: number | null; multi: boolean; askContact: boolean; counterId: string | null; storeId: string | null; active?: boolean }, taken: string[] = []): Promise<PayLink> {
  const title = l.title.trim().slice(0, 80)
  if (!title) throw new Error("Say what it's for")
  if (l.amount !== null && !(l.amount >= 0.01 && l.amount <= 100000)) throw new Error('Enter a price between $0.01 and $100,000')
  const row: Record<string, unknown> = { title, description: l.description?.trim().slice(0, 200) || null, amount: l.amount, multi: l.multi, ask_contact: l.askContact,
    counter_id: l.counterId, store_id: l.storeId, ...(l.active !== undefined ? { active: l.active } : {}) }
  if (!l.id) {
    let slug = linkSlug(title), n = 2
    while (taken.includes(slug)) slug = `${linkSlug(title).slice(0, 33)}-${n++}`
    row.slug = slug
  }
  const q = l.id ? supabase.from('business_pay_links').update(row).eq('id', l.id) : supabase.from('business_pay_links').insert(row)
  const { data, error } = await q.select('*').single()
  if (error && /duplicate|unique/i.test(error.message)) throw new Error('You already have a link with that name - change the name a little')
  fail(error)
  return mapLink(data)
}

export async function setPayLinkActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('business_pay_links').update({ active }).eq('id', id)
  fail(error)
}

export async function deletePayLink(id: string): Promise<void> {
  const { error } = await supabase.from('business_pay_links').delete().eq('id', id)
  fail(error)
}

export const payLinkUrl = (origin: string, handle: string, slug: string) => `${origin}/l/${handle.replace(/\.arc$/i, '')}/${slug}`

// ── The customer's side of a link ─────────────────────────────────────────
export type PublicPayLink = { id: string; title: string; description: string | null; amount: number | null; multi: boolean; askContact: boolean; storeId: string | null; open: boolean }

export async function getPublicPayLink(username: string, slug: string): Promise<PublicPayLink | null> {
  if (import.meta.env.VITE_E2E === '1') {
    try { if (localStorage.getItem('meshport_e2e_paylink') === '1') return { id: 'l1', title: 'Weekly veg box', description: '5 kg seasonal vegetables, delivered Sunday', amount: 20, multi: true, askContact: true, storeId: null, open: true } } catch { /* storage off */ }
  }
  const { data, error } = await supabase.rpc('pay_link_info', { p_username: username, p_slug: slug })
  if (error || !data) return null
  const d = data as any
  return { id: d.id, title: d.title, description: d.description ?? null, amount: d.amount === null ? null : Number(d.amount), multi: !!d.multi, askContact: !!d.askContact, storeId: d.storeId ?? null, open: !!d.open }
}

/** Opens an order for the link (its price, or `amount`); returns the order's code. */
export async function openPayLinkOrder(username: string, slug: string, amount: number | null, payer?: { name?: string; contact?: string }): Promise<string> {
  const { data, error } = await supabase.rpc('pay_link_open', { p_username: username, p_slug: slug, p_amount: amount, p_payer_name: payer?.name || null, p_payer_contact: payer?.contact || null })
  fail(error)
  return String(data)
}

// Test build only (VITE_E2E): sample counters and links for screenshots.
const E2E_COUNTERS: Counter[] = [
  { id: 'c1', name: 'Main counter', storeId: null, staffUids: [], createdAt: '2026-11-01T00:00:00Z' },
  { id: 'c2', name: 'Counter 2', storeId: null, staffUids: [], createdAt: '2026-11-02T00:00:00Z' },
]
const E2E_LINKS: PayLink[] = [
  { id: 'l1', slug: 'weekly-veg-box', title: 'Weekly veg box', description: '5 kg seasonal vegetables, delivered Sunday', amount: 20, multi: true, askContact: true, counterId: 'c1', storeId: null, active: true, createdAt: '2026-11-20T00:00:00Z' },
  { id: 'l2', slug: 'cake-deposit', title: 'Cake order deposit', description: null, amount: null, multi: true, askContact: false, counterId: null, storeId: null, active: true, createdAt: '2026-11-18T00:00:00Z' },
]
