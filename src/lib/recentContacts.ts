// ── Recent contacts — single source of truth ────────────────────────────────
// This is the "Home Avatar Recent" logic, factored out so every surface that
// shows a Recent list (Home avatar row, Send/Pay recent row, View-all Recent
// page) stays perfectly in sync:
//   1. Pull the wallet's most recent send + receive activity
//   2. Order counterparties by most-recent-first, de-duped
//   3. Only ever show registered MeshPort users (must have a `username`) —
//      raw/unresolved wallet addresses are never shown as "Recent"
//   4. Hide anything the user has explicitly removed from their contacts
//
// Callers only differ in how many activity rows they scan and how many
// people they ultimately display (avatar rows show 5, the full page shows
// 20), which is controlled via `opts` below.

import { getUsersByWalletAddresses } from './supabase'
import { getRemovedContacts } from './removedContacts'

export interface RecentContact {
  id: string
  wallet_address: string
  username: string
  display_name: string | null
  avatar_url: string | null
  last_amount: number
  last_paid: string
  total_sent: number
  times_sent: number
  /** True when this "contact" is the viewer's own wallet — a self-transfer
   * (paid your own username or address). See fetchRecentContacts's own
   * comment on why self is now included here at all. */
  isSelf: boolean
}

export interface FetchRecentContactsOpts {
  /** How many activity rows to scan per direction (send/receive). Default 20. */
  activityLimit?: number
  /** How many distinct counterparty addresses to resolve profiles for. Default 10. */
  maxAddresses?: number
  /** How many people to return after filtering. Default 5. */
  resultLimit?: number
}

// Short-lived cache shared across every caller (Home's avatar Recent row,
// Send/"Pay on Arc"'s Recent row, and the View-all Recent page all call this
// with the same or similar opts). Without it, navigating Home → Pay on Arc
// re-runs the full fetch from scratch every time, even seconds after Home
// just loaded the identical data — which is what made Recent feel slow to
// load on both screens. Keyed by wallet + opts so different callers (e.g.
// the View-all page asking for 20 results vs the 5-avatar row) don't share
// a result that doesn't match what they asked for.
const _recentCache = new Map<string, { data: RecentContact[]; ts: number }>()
const RECENT_CACHE_TTL_MS = 15_000

export async function fetchRecentContacts(
  walletAddress: string,
  opts: FetchRecentContactsOpts = {}
): Promise<RecentContact[]> {
  const { activityLimit = 20, maxAddresses = 10, resultLimit = 5 } = opts
  if (!walletAddress) return []

  const cacheKey = `${walletAddress.toLowerCase()}:${activityLimit}:${maxAddresses}:${resultLimit}`
  const cached = _recentCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < RECENT_CACHE_TTL_MS) return cached.data

  const SUPA_URL = (import.meta.env.VITE_SUPABASE_URL as string) || ''
  const SUPA_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || ''
  const { authHeaders } = await import('./chatService')
  const headers = await authHeaders()
  const myAddr = walletAddress.toLowerCase()

  // Fetch sent + received in parallel — same as Home Avatar Recent
  const [sentRes, recvRes] = await Promise.all([
    fetch(`${SUPA_URL}/rest/v1/activity?wallet_address=eq.${myAddr}&activity_type=eq.send&order=created_at.desc&limit=${activityLimit}&select=counterparty_address,amount,created_at`, { headers }),
    fetch(`${SUPA_URL}/rest/v1/activity?wallet_address=eq.${myAddr}&activity_type=eq.receive&order=created_at.desc&limit=${activityLimit}&select=counterparty_address,amount,created_at`, { headers }),
  ])
  const [sentRows, recvRows] = await Promise.all([sentRes.json(), recvRes.json()])

  const rows = [...(Array.isArray(sentRows) ? sentRows : []), ...(Array.isArray(recvRows) ? recvRows : [])]
    .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

  // Merge & dedup by most recent, while keeping per-address stats
  // (needed by the View-all page; unused fields are simply ignored by the
  // avatar-row callers).
  const seen = new Set<string>()
  const addrs: string[] = []
  const stats = new Map<string, { amounts: number[]; dates: string[] }>()
  for (const r of rows) {
    const addr = (r.counterparty_address || '').toLowerCase()
    // Self-transfer (paid your own username/address) is now included here
    // deliberately — previously skipped via `addr === myAddr`, which is why
    // Recent used to never show a self-payment at all. isSelf below is what
    // lets callers label this entry "You" instead of resolving it as if it
    // were an ordinary contact.
    if (!addr) continue
    if (!stats.has(addr)) stats.set(addr, { amounts: [], dates: [] })
    stats.get(addr)!.amounts.push(parseFloat(r.amount || 0))
    stats.get(addr)!.dates.push(r.created_at)
    if (!seen.has(addr)) { seen.add(addr); addrs.push(addr) }
  }

  const candidateAddrs = addrs.slice(0, maxAddresses)
  if (!candidateAddrs.length) return []

  // Batch resolve all profiles in one query — resolves myAddr to your own
  // profile the same as any other address, since you're a registered user too.
  const profileMap = await getUsersByWalletAddresses(candidateAddrs).catch(() => new Map())
  const removed = getRemovedContacts(walletAddress)

  const result: RecentContact[] = candidateAddrs
    .map(addr => profileMap.get(addr))
    .filter((u): u is NonNullable<typeof u> => !!u)
    // Home Avatar Recent rule: only ever show registered MeshPort users
    .filter(u => !!u.username)
    // Self is never in the removed-contacts blocklist, but this filter
    // should never accidentally hide it either way — checked by isSelf,
    // not skipped here.
    .filter(u => u.wallet_address.toLowerCase() === myAddr || !removed.has(u.id))
    .map(u => {
      const s = stats.get(u.wallet_address.toLowerCase()) || { amounts: [], dates: [] }
      return {
        id: u.id,
        wallet_address: u.wallet_address,
        username: u.username,
        display_name: u.display_name || null,
        avatar_url: u.avatar_url || null,
        last_amount: s.amounts[0] || 0,
        last_paid: s.dates[0] || '',
        total_sent: s.amounts.reduce((sum, v) => sum + v, 0),
        times_sent: s.amounts.length,
        isSelf: u.wallet_address.toLowerCase() === myAddr,
      }
    })
    .slice(0, resultLimit)

  _recentCache.set(cacheKey, { data: result, ts: Date.now() })
  return result
}

/** Call after sending/receiving a payment or removing a contact — clears the
 * short-lived cache above so the next Recent-row fetch reflects the change
 * immediately instead of returning a snapshot from just before it. */
export function invalidateRecentContactsCache() {
  _recentCache.clear()
}

// ── Shared display helpers ───────────────────────────────────────────────────
export function recentInitial(c: { display_name?: string | null; username?: string | null; isSelf?: boolean }) {
  if (c.isSelf) return 'Y'
  return ((c.display_name || c.username || 'U').replace(/\.arc$/, '')).charAt(0).toUpperCase()
}

export function recentShortName(c: { display_name?: string | null; username?: string | null; isSelf?: boolean }) {
  if (c.isSelf) return 'You'
  if (c.username) return c.username.replace(/\.arc$/, '')
  if (c.display_name) return c.display_name.replace(/\.arc$/, '').split(' ')[0]
  return '??'
}

/** Click target for a Recent entry → pre-fills /send with this recipient */
export function recentSendTarget(c: { username?: string | null; display_name?: string | null; wallet_address: string; avatar_url?: string | null }) {
  const username = c.username ? c.username.replace(/\.arc$/, '') : ''
  const displayName = c.display_name || username || c.wallet_address
  // 4th segment carries the avatar URL so PaySendPage's sync compound parser
  // can show the real photo immediately, instead of dropping it and
  // falling back to initials the way the plain username|wallet|name format
  // used to (the "recent avatar click → Send/Pay shows no avatar" bug).
  // Safe to '|'-delimit: avatar_url is a plain Supabase storage URL and the
  // whole string is encodeURIComponent'd by callers before it hits the URL.
  return username ? `${username}|${c.wallet_address}|${displayName}|${c.avatar_url || ''}` : c.wallet_address
}

export const RECENT_AVATAR_COLORS = ['#1e3a7f', '#1a5c38', '#4a1a6e', '#7a3010', '#0a3a6e', '#1a4a6e', '#3a1a5e', '#0a4a2e', '#5e1a1a', '#1a3a4e']
