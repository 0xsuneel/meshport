// src/lib/merchant.ts
//
// Merchant accounts. A user applies from Profile → Apply for merchant; an
// admin approves or rejects it (Admin → Merchants). Only an APPROVED
// application turns on the merchant flow:
//   • Multichain Hub: "Bring Funds" becomes "Ledger" (UB chains only)
//   • incoming USDC on UB chains is collected to Arc automatically
//   • those claims show as "Payment received" with the chain + address
// Everyone else — no application, pending, rejected or revoked — keeps the
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
}

type State = { loaded: boolean; status: MerchantStatus; application: MerchantApplication | null }

let state: State = { loaded: false, status: 'none', application: null }
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())
const set = (s: State) => { state = s; emit(); if (s.loaded) rememberHint(s.status === 'approved') }

// Display hint only: the last known "is a merchant" for this wallet, so the
// screen opens with the right labels (Merchant Hub / Ledger) instead of
// flashing the normal ones for a moment after a reload. The real status
// from the server replaces it as soon as it loads; isMerchantNow() (used by
// non-UI code) never reads the hint.
const HINT_KEY = 'meshport_merchant_hint'
function currentWallet(): string {
  try { return (useAuthStore.getState().walletAddress || '').toLowerCase() } catch { return '' }
}
function rememberHint(approved: boolean) {
  try {
    const w = currentWallet()
    if (w) localStorage.setItem(HINT_KEY, JSON.stringify({ w, approved }))
  } catch { /* storage unavailable */ }
}
function readHint(): boolean {
  try {
    const h = JSON.parse(localStorage.getItem(HINT_KEY) || 'null')
    return !!h && h.approved === true && h.w === currentWallet()
  } catch { return false }
}

function mapRow(r: any): MerchantApplication {
  return {
    id: r.id, businessName: r.business_name, businessType: r.business_type ?? null,
    contact: r.contact ?? null, description: r.description ?? null, status: r.status,
    reviewNote: r.review_note ?? null, reviewedAt: r.reviewed_at ?? null, createdAt: r.created_at,
    walletAddress: r.wallet_address ?? null, username: r.username ?? null,
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
// the new login) — so a "no application" answer is re-checked once shortly
// after, and again whenever a new session signs in.
let recheckedUid: string | null = null
try {
  supabase.auth?.onAuthStateChange?.(event => {
    if (event === 'SIGNED_IN' && state.status !== 'approved') {
      setTimeout(() => { loading = null; void refreshMerchant() }, 1500)
    }
  })
} catch { /* no auth client (tests) */ }
// This session was just linked to the account (wallet-signed) — merchant rows
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
      if (!uid) { set({ loaded: true, status: 'none', application: null }); return }
      const { data } = await supabase.from('merchant_applications').select('*')
        .eq('auth_uid', uid).order('created_at', { ascending: false }).limit(1)
      const app = data?.[0] ? mapRow(data[0]) : null
      set({ loaded: true, status: app?.status ?? 'none', application: app })
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
      set({ ...state, loaded: true })
    } finally {
      loading = null
    }
  })()
  return loading
}

/** Clears cached merchant state (sign-out). */
export function resetMerchant() {
  channel?.unsubscribe(); channel = null; channelUid = null
  set({ loaded: false, status: 'none', application: null })
}

/** True only for an approved merchant. Safe to call from non-React code. */
export function isMerchantNow(): boolean {
  return state.status === 'approved'
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  if (!state.loaded) void refreshMerchant()
  return () => { listeners.delete(cb) }
}
const getSnapshot = () => state

export function useMerchant(): State & { isMerchant: boolean; refresh: () => Promise<void> } {
  const s = useSyncExternalStore(subscribe, getSnapshot)
  return { ...s, isMerchant: s.loaded ? s.status === 'approved' : readHint(), refresh: refreshMerchant }
}

export async function applyForMerchant(p: {
  businessName: string; businessType?: string; contact?: string; description?: string
}): Promise<void> {
  const name = p.businessName.trim()
  if (name.length < 2) throw new Error('Enter your business name')
  const { error } = await supabase.from('merchant_applications').insert({
    business_name: name.slice(0, 80),
    business_type: p.businessType?.trim().slice(0, 60) || null,
    contact:       p.contact?.trim().slice(0, 120) || null,
    description:   p.description?.trim().slice(0, 500) || null,
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

/** Merchant accounts see the Multichain Hub as "Merchant Hub" (label only). */
export function hubLabel(label: string, isMerchant: boolean): string {
  return isMerchant && label === 'Multichain Hub' ? 'Merchant Hub' : label
}
export function useHubLabel(): (label: string) => string {
  const { isMerchant } = useMerchant()
  return (label: string) => hubLabel(label, isMerchant)
}
