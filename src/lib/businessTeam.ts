// Business → Stores & outlets, and Staff & roles.
//
// Stores: the owner's outlets (business_stores). Requests made for a store
// carry its id, so Business can show one store's payments at a time.
// Staff: users the owner invited as cashier or manager (business_staff).
// Staff create requests that pay the owner through staff_create_request and
// read the owner's payments through staff_payments; refunds, settlements and
// cash out stay with the owner (their key signs them).
import { supabase } from '@/lib/supabase'
import { mapIntent, type MerchantIntent, type MerchantPayment, type InvoiceItem } from '@/lib/merchantPay'
import type { MerchantRefund } from '@/lib/merchantRefunds'

/** `name` is the owner's own label; customers see `publicName` (null until
 *  MeshPort has reviewed it - they see just the business name then).
 *  `nameInReview`: a new name is waiting for that review. */
export type Store = { id: string; name: string; publicName: string | null; nameInReview: boolean
  /** The owner's logo for this store, what customers see (after review), and whether a new one is waiting. */
  logoUrl: string | null; publicLogoUrl: string | null; logoInReview: boolean; type: string | null; address: string | null; taxId: string | null; isDefault: boolean; createdAt: string
  /** Bills from this store: tax (name, rate, prices include it) and a footer note. */
  tax: StoreTax; billFooter: string | null }
export type StoreTax = { enabled: boolean; name: string; rate: number; inclusive: boolean }
export type StaffRole = 'cashier' | 'manager'
export type StaffMember = { id: string; username: string; role: StaffRole; status: 'invited' | 'active'; storeId: string | null; createdAt: string; authUid?: string | null }
export type Membership = { id: string; ownerAuthUid: string; ownerName: string; ownerUsername: string; role: StaffRole; status: 'invited' | 'active'; storeId: string | null; storeName: string | null; storePublicName: string | null }

const mapStore = (r: any): Store => ({ id: r.id, name: r.name, publicName: r.public_name ?? null, nameInReview: !!r.name_review_since, logoUrl: r.logo_url ?? null, publicLogoUrl: r.public_logo_url ?? null, logoInReview: !!r.logo_review_since, type: r.type ?? null, address: r.address ?? null, taxId: r.tax_id ?? null, isDefault: !!r.is_default, createdAt: r.created_at,
  tax: { enabled: !!r.tax_enabled && Number(r.tax_rate) > 0, name: r.tax_name || 'Tax', rate: Number(r.tax_rate) || 0, inclusive: !!r.tax_inclusive },
  billFooter: r.bill_footer ?? null })
const fail = (e: { message: string } | null) => { if (e) throw new Error(e.message.replace(/^.*?ERROR:\s*/, '')) }

async function myUid(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.user?.id ?? null
}

// ── Stores ──────────────────────────────────────────────────────────────
export async function listStores(): Promise<Store[]> {
  const uid = await myUid()
  if (!uid) return []
  const { data, error } = await supabase.from('business_stores').select('*').eq('owner_auth_uid', uid).order('created_at')
  fail(error)
  return (data ?? []).map(mapStore)
}

export async function saveStore(s: { id?: string; name: string; type?: string; address?: string; taxId?: string; isDefault?: boolean; logoUrl?: string | null; tax?: StoreTax; billFooter?: string }): Promise<Store> {
  const name = s.name.trim()
  if (name.length < 2) throw new Error('Enter the store name')
  const row = { name: name.slice(0, 60), type: s.type || null, address: s.address?.trim().slice(0, 160) || null,
    ...(s.taxId !== undefined ? { tax_id: s.taxId.trim().toUpperCase().slice(0, 40) || null } : {}),
    ...(s.isDefault !== undefined ? { is_default: s.isDefault } : {}),
    ...(s.logoUrl !== undefined ? { logo_url: s.logoUrl } : {}),
    ...(s.tax ? { tax_enabled: s.tax.enabled && s.tax.rate > 0, tax_name: s.tax.name.trim().slice(0, 20) || null,
      tax_rate: Math.min(100, Math.max(0, s.tax.rate)) || null, tax_inclusive: s.tax.inclusive } : {}),
    ...(s.billFooter !== undefined ? { bill_footer: s.billFooter.trim().slice(0, 200) || null } : {}) }
  const q = s.id ? supabase.from('business_stores').update(row).eq('id', s.id) : supabase.from('business_stores').insert(row)
  const { data, error } = await q.select('*').single()
  fail(error)
  return mapStore(data)
}

/** Uploads a store's logo (squared to 512 px) and returns its public URL. */
export async function uploadStoreLogo(file: File, storeKey: string): Promise<string> {
  if (!/^image\//.test(file.type)) throw new Error('Pick an image (JPG, PNG or WebP)')
  if (file.size > 15 * 1024 * 1024) throw new Error('Image too large - up to 15 MB')
  const { compressImage } = await import('@/lib/imageCompress')
  const small = await compressImage(file)
  const name = `store-logos/${storeKey.replace(/[^A-Za-z0-9-]/g, '')}_${Date.now()}.jpg`
  const { error } = await supabase.storage.from('attachments').upload(name, small, { cacheControl: '31536000', upsert: false, contentType: 'image/jpeg' })
  fail(error)
  return `${supabase.storage.from('attachments').getPublicUrl(name).data.publicUrl}?t=${Date.now()}`
}

export async function deleteStore(id: string): Promise<void> {
  const { error } = await supabase.from('business_stores').delete().eq('id', id)
  fail(error)
}

/** Make `id` the business's main (default) store - clears the old default. */
export async function setDefaultStore(id: string): Promise<void> {
  const { error } = await supabase.rpc('business_set_default_store', { p_id: id })
  fail(error)
}

/** Which store this device is working as (null = all stores). */
const ACTIVE_KEY = 'meshport_business_store'
export function activeStoreId(): string | null { try { return localStorage.getItem(ACTIVE_KEY) } catch { return null } }
export function setActiveStoreId(id: string | null) { try { id ? localStorage.setItem(ACTIVE_KEY, id) : localStorage.removeItem(ACTIVE_KEY) } catch { /* storage off */ } }

// ── Staff (owner side) ─────────────────────────────────────────────────
export async function listStaff(): Promise<StaffMember[]> {
  const uid = await myUid()
  if (!uid) return []
  const { data, error } = await supabase.from('business_staff').select('*').eq('owner_auth_uid', uid).order('created_at')
  fail(error)
  return (data ?? []).map((r: any) => ({ id: r.id, username: r.staff_username, role: r.role, status: r.status, storeId: r.store_id ?? null, createdAt: r.created_at, authUid: r.staff_auth_uid ?? null }))
}

export async function inviteStaff(username: string, role: StaffRole, storeId: string | null): Promise<void> {
  const { error } = await supabase.rpc('business_staff_invite', { p_username: username, p_role: role, p_store: storeId })
  fail(error)
}

export async function updateStaff(id: string, role: StaffRole, storeId: string | null): Promise<void> {
  const { error } = await supabase.from('business_staff').update({ role, store_id: storeId }).eq('id', id)
  fail(error)
}

export async function removeStaff(id: string): Promise<void> {
  const { error } = await supabase.from('business_staff').delete().eq('id', id)
  fail(error)
}

// ── Staff (staff side) ─────────────────────────────────────────────────
export async function myMemberships(): Promise<Membership[]> {
  const { data, error } = await supabase.rpc('business_staff_memberships')
  if (error) return []
  return (data ?? []).map((r: any) => ({ id: r.id, ownerAuthUid: r.owner_auth_uid, ownerName: r.owner_name, ownerUsername: r.owner_username,
    role: r.role, status: r.status, storeId: r.store_id ?? null, storeName: r.store_name ?? null, storePublicName: r.store_public_name ?? null }))
}

export async function acceptInvite(id: string): Promise<void> {
  const { error } = await supabase.rpc('business_staff_accept', { p_id: id })
  fail(error)
}

export async function staffCreateRequest(owner: string, p: { amount: number; note?: string; expiresInMinutes?: number | null; storeId?: string | null; items?: InvoiceItem[]; customer?: string }): Promise<MerchantIntent> {
  const { data, error } = await supabase.rpc('staff_create_request', {
    p_owner: owner, p_amount: Number(p.amount.toFixed(6)), p_note: p.note ?? null, p_expires_minutes: p.expiresInMinutes ?? 0,
    p_store: p.storeId ?? null, p_items: p.items?.length ? p.items : null, p_customer: p.customer?.replace(/^@/, '') || null,
  })
  fail(error)
  const r = data as any
  return { id: r.id, code: r.code, orderNumber: r.order_number ?? null, amount: Number(r.requested_amount), received: Number(r.received_amount), note: r.note,
    customerUsername: r.customer_username, customerWallet: null, status: r.status, sourceChain: null, paymentMethod: null, createdAt: r.created_at,
    expiresAt: r.expires_at, paidAt: null, kind: r.kind === 'invoice' ? 'invoice' : 'request', items: r.items ?? null,
    completedByMerchant: false, completedNote: null, storeId: r.store_id ?? null }
}

/** A manager's Requests: the business's requests and bills for their store
 *  (staff_intents - managers only). Unpaid Shop QR orders left out, as for the owner. */
export async function staffIntents(owner: string): Promise<MerchantIntent[]> {
  const { data, error } = await supabase.rpc('staff_intents', { p_owner: owner, p_limit: 500 })
  fail(error)
  return ((data ?? []) as any[]).map(mapIntent).filter(i => i.via !== 'shop_qr' || i.received > 0)
}

/** Refunds on a manager's store's payments, for their statement (managers only). */
export async function staffRefunds(owner: string): Promise<MerchantRefund[]> {
  const { data, error } = await supabase.rpc('staff_refunds', { p_owner: owner })
  fail(error)
  return ((data ?? []) as any[]).map(r => ({ id: r.id, paymentId: r.payment_id ?? `rcpt_${r.receipt_id}`, amount: Number(r.amount), reason: r.reason ?? '',
    txHash: r.tx_hash, createdAt: r.created_at, chain: r.refund_chain ?? 'Arc_Testnet', route: r.route ?? 'contract' }))
}

export async function staffPayments(owner: string): Promise<MerchantPayment[]> {
  const { data, error } = await supabase.rpc('staff_payments', { p_owner: owner, p_limit: 500 })
  fail(error)
  return (data ?? []).map((r: any) => ({ id: r.id, intentId: r.intent_id, chain: r.source_chain, txHash: r.tx_hash, from: r.from_address, amount: Number(r.amount),
    method: '', status: r.status, customerUsername: r.customer_username, createdAt: r.created_at, orderNumber: r.order_number ?? null, matchedBy: null,
    late: r.late === true, screenFlag: r.screen_flag ?? null }))
}
