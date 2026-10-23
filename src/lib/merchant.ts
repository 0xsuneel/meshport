// src/lib/merchant.ts
//
// Merchant accounts. Only business accounts (chosen at sign-up) apply - the
// database refuses applications from personal accounts; an admin approves
// or rejects it (Admin → Merchants). Only an APPROVED
// application turns on the merchant flow:
//   • Multichain Hub: "Bring Funds" becomes "Other chains" (UB and CCTP chains)
//   • USDC on other chains waits there until the merchant taps Claim All
//   • those claims show as "Payment received" with the chain + address
// Everyone else - no application, pending, rejected or revoked - keeps the
// normal flow exactly as it is.
//
// Identity (user id, wallet, username) is filled in by the database from the
// signed-in session, never from this client. Status only changes via admins.

import { useSyncExternalStore } from 'react'
import { supabase } from './supabase'
import { useAuthStore } from '@/store'

export type MerchantStatus = 'none' | 'pending' | 'approved' | 'rejected' | 'revoked'

export type MerchantApplication = {
  id: string
  businessName: string
  businessType: string | null
  contact: string | null
  description: string | null
  status: Exclude<MerchantStatus, 'none'>
  reviewNote: string | null
  reviewedAt: string | null
  createdAt: string
  walletAddress: string | null
  username: string | null
  /** GST, VAT, EIN, ABN, business licence… as typed (upper-cased). */
  registrationNumber: string | null
  documents: BusinessDoc[]
}

/** A file the applicant attached for the admin (private bucket). */
export type BusinessDocKind = 'id' | 'shop_photo' | 'registration' | 'other'
export type BusinessDoc = { path: string; kind: BusinessDocKind; name: string }
export const BUSINESS_DOC_KINDS: Array<{ id: BusinessDocKind; label: string }> = [
  { id: 'id', label: 'Owner ID' }, { id: 'shop_photo', label: 'Shop photo' },
  { id: 'registration', label: 'Registration' }, { id: 'other', label: 'Other' },
]
const DOCS_BUCKET = 'business-docs'
const DOC_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }
export const MAX_BUSINESS_DOCS = 5
export const MAX_BUSINESS_DOC_BYTES = 5 * 1024 * 1024

type State = {
  loaded: boolean; status: MerchantStatus; application: MerchantApplication | null
  /** Chosen at sign-up. Business accounts get the Business tab at once; the
   *  merchant application (with its reason) can be completed later. */
  accountType: 'personal' | 'business'; storeName: string | null
}

let state: State = { loaded: false, status: 'none', application: null, accountType: 'personal', storeName: null }
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())
const set = (s: State) => { state = s; emit(); if (s.loaded) rememberHint(s.status === 'approved', s.accountType === 'business') }

// Display hint only: the last known "is a merchant" for this wallet, so the
// screen opens with the right labels (Cross-chain Transfer / Manage money) instead of
// flashing the normal ones for a moment after a reload. The real status
// from the server replaces it as soon as it loads; isMerchantNow() (used by
// non-UI code) never reads the hint.
const HINT_KEY = 'meshport_merchant_hint'
function currentWallet(): string {
  try { return (useAuthStore.getState().walletAddress || '').toLowerCase() } catch { return '' }
}
function rememberHint(approved: boolean, business: boolean) {
  try {
    const w = currentWallet()
    if (w) localStorage.setItem(HINT_KEY, JSON.stringify({ w, approved, business }))
  } catch { /* storage unavailable */ }
}
/** Last known merchant status for this wallet, or null when there is none
 *  (first load on this device). `business` is null in hints written before
 *  the account type was remembered. */
export function readMerchantHint(): { approved: boolean; business: boolean | null } | null {
  try {
    const h = JSON.parse(localStorage.getItem(HINT_KEY) || 'null')
    if (!h || h.w !== currentWallet() || !h.w) return null
    return { approved: h.approved === true, business: typeof h.business === 'boolean' ? h.business : null }
  } catch { return null }
}
function readHint(): boolean {
  return readMerchantHint()?.approved === true
}

function mapRow(r: any): MerchantApplication {
  return {
    id: r.id, businessName: r.business_name, businessType: r.business_type ?? null,
    contact: r.contact ?? null, description: r.description ?? null, status: r.status,
    reviewNote: r.review_note ?? null, reviewedAt: r.reviewed_at ?? null, createdAt: r.created_at,
    walletAddress: r.wallet_address ?? null, username: r.username ?? null,
    registrationNumber: r.registration_number ?? null,
    documents: Array.isArray(r.documents) ? r.documents.filter((d: any) => d?.path).map((d: any) => ({ path: d.path, kind: d.kind, name: d.name || 'Document' })) : [],
  }
}

async function authUid(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.user?.id ?? null
}

let loading: Promise<void> | null = null
let channel: ReturnType<typeof supabase.channel> | null = null
let channelUid: string | null = null
// Right after a sign-in the account's new login id may not be linked to its
// merchant rows for a moment (the database does it when the users row gets
// the new login) - so a "no application" answer is re-checked once shortly
// after, and again whenever a new session signs in.
let recheckedUid: string | null = null
// A failed load (network) keeps the last known state - never "personal" - and
// is retried a few times with backoff.
let failures = 0
try {
  supabase.auth?.onAuthStateChange?.(event => {
    if (event === 'SIGNED_IN' && state.status !== 'approved') {
      setTimeout(() => { loading = null; void refreshMerchant() }, 1500)
    }
  })
} catch { /* no auth client (tests) */ }
// This session was just linked to the account (wallet-signed) - merchant rows
// follow the link, so load again.
try {
  window.addEventListener('meshport:session-bound', () => { loading = null; void refreshMerchant() })
} catch { /* no window */ }

/** Loads (or reloads) this user's latest application. */
export function refreshMerchant(): Promise<void> {
  if (loading) return loading
  loading = (async () => {
    try {
      const uid = await authUid()
      if (!uid) { set({ loaded: true, status: 'none', application: null, accountType: 'personal', storeName: null }); return }
      const [{ data, error }, { data: meRows, error: meErr }] = await Promise.all([
        supabase.from('merchant_applications').select('*').eq('auth_uid', uid).order('created_at', { ascending: false }).limit(1),
        // Own profile via RPC - users.auth_uid isn't readable from the app.
        supabase.rpc('my_profile'),
      ])
      if (error || meErr) throw error || meErr
      const me = (Array.isArray(meRows) ? meRows[0] : meRows) as { account_type?: string | null; store_name?: string | null } | null | undefined
      failures = 0
      const app = data?.[0] ? mapRow(data[0]) : null
      set({ loaded: true, status: app?.status ?? 'none', application: app,
        accountType: me?.account_type === 'business' ? 'business' : 'personal', storeName: me?.store_name ?? null })
      if (!app && recheckedUid !== uid) {
        recheckedUid = uid
        setTimeout(() => { loading = null; void refreshMerchant() }, 3000)
      }
      // Live: an admin's decision shows up without a refresh.
      if (channelUid !== uid) {
        channel?.unsubscribe()
        channelUid = uid
        channel = supabase.channel(`merchant-app-${uid}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'merchant_applications', filter: `auth_uid=eq.${uid}` },
            () => { loading = null; void refreshMerchant() })
          .subscribe()
      }
    } catch {
      const wait = failures < 4 ? 1000 * 2 ** failures++ : 30_000
      setTimeout(() => { loading = null; void refreshMerchant() }, wait)
    } finally {
      loading = null
    }
  })()
  return loading
}

/** Clears cached merchant state (sign-out). */
export function resetMerchant() {
  channel?.unsubscribe(); channel = null; channelUid = null
  set({ loaded: false, status: 'none', application: null, accountType: 'personal', storeName: null })
}

/** True only for an approved merchant. Safe to call from non-React code. */
export function isMerchantNow(): boolean {
  return state.status === 'approved'
}

/** True for any business/merchant account (business sign-up, or an approved
 *  merchant). Business accounts don't earn transaction rewards, so this gates
 *  reward awarding/notifications. Falls back to the cached hint before the
 *  server state has loaded. Safe to call from non-React code. */
export function isBusinessAccountNow(): boolean {
  if (state.loaded) return state.accountType === 'business' || state.status === 'approved'
  const hint = readMerchantHint()
  return hint?.business === true || hint?.approved === true
}

/**
 * A claim from another chain by an approved merchant moves customer payments
 * to Arc - shown as "Cross-chain payment received". New rows carry metadata.merchant
 * (tagged server-side when written); rows written before that tag existed
 * are recognised by date: made on another chain after the approval.
 */
export function isMerchantClaim(p: { metadata?: any; createdAt?: string; sourceChain?: string }): boolean {
  if (p.metadata?.merchant) return true
  // Business accounts: every claim from another chain is a settlement.
  if (state.accountType === 'business') return !!p.sourceChain && p.sourceChain !== 'Arc_Testnet'
  const approvedAt = state.status === 'approved' ? state.application?.reviewedAt : null
  if (!approvedAt || !p.createdAt || !p.sourceChain || p.sourceChain === 'Arc_Testnet') return false
  return new Date(p.createdAt).getTime() >= new Date(approvedAt).getTime()
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  if (!state.loaded) void refreshMerchant()
  return () => { listeners.delete(cb) }
}
const getSnapshot = () => state
/** Current merchant state (non-React code). */
export function getMerchantState(): Readonly<State> { return state }
/** Subscribe to merchant state changes (non-React code). Starts a load. */
export function subscribeMerchant(cb: () => void): () => void { return subscribe(cb) }

export function useMerchant(): State & { isMerchant: boolean; refresh: () => Promise<void> } {
  const s = useSyncExternalStore(subscribe, getSnapshot)
  return { ...s, isMerchant: s.loaded ? s.status === 'approved' : readHint(), refresh: refreshMerchant }
}

/** Business → the business's display name (empty clears it; the username shows then). */
export async function setBusinessName(name: string): Promise<void> {
  const { error } = await supabase.rpc('set_business_name', { p_name: name })
  if (error) throw new Error(error.message)
  await refreshMerchant()
}

/** Uploads one application document into the signed-in login's own folder.
 *  The database checks the file is there when the application is sent. */
export async function uploadBusinessDoc(file: File, kind: BusinessDocKind): Promise<BusinessDoc> {
  const ext = DOC_TYPES[file.type]
  if (!ext) throw new Error('Use a photo (JPG, PNG, WebP) or a PDF')
  if (file.size > MAX_BUSINESS_DOC_BYTES) throw new Error('Each file can be up to 5 MB')
  const uid = await authUid()
  if (!uid) throw new Error('Sign in again to upload')
  const path = `${uid}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from(DOCS_BUCKET).upload(path, file, { upsert: false, contentType: file.type })
  if (error) throw new Error(error.message)
  return { path, kind, name: file.name.slice(0, 120) || 'Document' }
}

/** Removes a document picked by mistake (only allowed before it's sent). */
export async function removeBusinessDoc(path: string): Promise<void> {
  await supabase.storage.from(DOCS_BUCKET).remove([path])
}

/** Short-lived link to open an application document (owner or admin). */
export async function businessDocUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(DOCS_BUCKET).createSignedUrl(path, 300)
  if (error || !data?.signedUrl) throw new Error(error?.message || 'Could not open the document')
  return data.signedUrl
}

export async function applyForMerchant(p: {
  businessName: string; businessType?: string; contact?: string; description?: string
  registrationNumber?: string; documents?: BusinessDoc[]
}): Promise<void> {
  const name = p.businessName.trim()
  if (name.length < 2) throw new Error('Enter your business name')
  if ((p.description ?? '').trim().length < 10) throw new Error('Tell us why you need a business account')
  if (!p.documents?.length) throw new Error('Add at least one document - an ID or a photo of your shop')
  const { error } = await supabase.from('merchant_applications').insert({
    business_name: name.slice(0, 80),
    business_type: p.businessType?.trim().slice(0, 60) || null,
    contact:       p.contact?.trim().slice(0, 120) || null,
    description:   p.description?.trim().slice(0, 500) || null,
    registration_number: p.registrationNumber?.trim().slice(0, 40) || null,
    documents:     p.documents.slice(0, MAX_BUSINESS_DOCS).map(d => ({ path: d.path, kind: d.kind, name: d.name })),
  })
  if (error) {
    if (/merchant_applications_one_open|duplicate/i.test(error.message)) throw new Error('You already have an application under review.')
    throw new Error(error.message)
  }
  await refreshMerchant()
}

// ── Admin ───────────────────────────────────────────────────────────────────
export async function adminListMerchantApplications(): Promise<MerchantApplication[]> {
  const { data, error } = await supabase.from('merchant_applications').select('*').order('created_at', { ascending: false }).limit(500)
  if (error) throw new Error(error.message)
  return (data ?? []).map(mapRow)
}

export async function adminReviewMerchant(id: string, status: 'approved' | 'rejected' | 'revoked', note: string | null, reviewer: string): Promise<void> {
  const { error } = await supabase.from('merchant_applications')
    .update({ status, review_note: note?.trim() || null, reviewed_by: reviewer })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

/** Business accounts see the Multichain Hub as "Cross-chain Transfer" - their
 *  money from other chains is settled in the Business tab (label only). */
export function hubLabel(label: string, isMerchant: boolean): string {
  if (!isMerchant) return label
  return label === 'Multichain Hub' ? 'Cross-chain Transfer' : label === 'Insights' ? 'Business Insights' : label
}

/** Business tab instead of Rewards: every business account (from sign-up,
 *  approved or not yet), and older merchants who applied as personal users. */
export function useBusinessTab(): boolean {
  const { isMerchant, status, accountType } = useMerchant()
  return isMerchant || status === 'pending' || accountType === 'business'
}
export function useHubLabel(): (label: string) => string {
  const business = useBusinessTab()
  return (label: string) => hubLabel(label, business)
}
