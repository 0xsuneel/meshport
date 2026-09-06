/// <reference types="vite/client" />
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL  = (import.meta.env.VITE_SUPABASE_URL  as string) || ''
const SUPABASE_ANON = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || ''

if (!SUPABASE_URL || !SUPABASE_ANON) {
  console.error('[Supabase] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY')
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})

// ── Auto sign-in anonymously for wallet users ─────────────────────────────────
// The sb_publishable_ key format requires an auth session for ALL writes.
// Wallet users never do email/OTP login, so we sign them in anonymously.
// This gives a valid JWT so all Supabase inserts work with RLS using(true).
let _anonSignInDone = false
let _anonSignInPromise: Promise<void> | null = null

// Neither supabase.auth.getSession() nor .signInAnonymously() below had any
// timeout — a slow/unresponsive auth endpoint could leave this await
// pending indefinitely. That's exactly what made Create Wallet's "Confirm &
// Create Wallet" and Import Wallet's confirm step appear to hang with no
// error: both directly `await ensureAnonSession()` before finishing (see
// AuthPages.tsx), while the Google/Email auto-wallet path never calls this
// at all, which is why only create/import got stuck. This call is
// documented as best-effort (every caller already treats failure as
// non-fatal) — it should never be able to block the caller forever.
const ANON_SESSION_TIMEOUT_MS = 6000

export async function ensureAnonSession(): Promise<void> {
  if (_anonSignInDone) return
  // Deduplicate concurrent calls — only run one sign-in at a time
  if (_anonSignInPromise) return _anonSignInPromise
  _anonSignInPromise = (async () => {
    try {
      await Promise.race([
        (async () => {
          const { data: { session } } = await supabase.auth.getSession()
          if (session?.access_token) { _anonSignInDone = true; return }

          const { data, error } = await supabase.auth.signInAnonymously()
          if (error) {
              // anon sign-in failed — Enable at: Auth → Settings → Anonymous sign-ins
          } else if (data?.session) {
            _anonSignInDone = true
          }
        })(),
        new Promise<void>(resolve => setTimeout(resolve, ANON_SESSION_TIMEOUT_MS)),
      ])
    } catch (e) {
    } finally {
      _anonSignInPromise = null
    }
  })()
  return _anonSignInPromise
}

// ── Backfill users.auth_uid — links this app's wallet-derived user id to
// the real Supabase Auth session id (see supabase-SECURITY-REVIEW-scope-rls.sql
// for why this matters and what it unlocks). Safe to run on every app load:
// only writes when the value is missing or stale, and doesn't change any
// current RLS behavior on its own — the reviewed migration is what actually
// switches policies over to using it, and that must be applied separately
// after this has had a chance to backfill.
export async function syncAuthUidToProfile(userId: string): Promise<void> {
  if (!userId) return
  try {
    await ensureAnonSession()
    const { data: { user: authUser } } = await supabase.auth.getUser()
    if (!authUser?.id) return
    await supabase.from('users').update({ auth_uid: authUser.id }).eq('id', userId)
  } catch {
    // best-effort — column may not exist yet if the review migration hasn't
    // been applied; never let this block app load
  }
}


// Used as ultimate fallback when anonymous sign-in is disabled/unavailable.
// Reads SUPABASE_URL and anon key from the same env vars the client uses.
async function restInsertMessage(row: Record<string, unknown>): Promise<{ data: DbMessage | null; error: string | null }> {
  try {
    const url  = (import.meta.env.VITE_SUPABASE_URL  as string) || ''
    const akey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || ''
    if (!url || !akey) return { data: null, error: 'No Supabase config' }

    const res = await fetch(`${url}/rest/v1/messages`, {
      method: 'POST',
      headers: {
        'apikey':        akey,
        'Authorization': `Bearer ${akey}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=representation',
      },
      body: JSON.stringify(row),
    })
    const text = await res.text()
    let json: any
    try { json = JSON.parse(text) } catch { json = null }

    if (!res.ok) {
      console.error('[restInsertMessage] failed:', res.status, text.slice(0, 200))
      return { data: null, error: `REST ${res.status}: ${text.slice(0, 100)}` }
    }
    const msgRow = Array.isArray(json) ? json[0] : json
    return { data: msgRow as DbMessage, error: null }
  } catch (e: any) {
    return { data: null, error: e?.message || 'REST insert failed' }
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────
export interface DbUser {
  id: string
  username: string
  display_name: string
  email: string
  wallet_address: string
  avatar_url: string | null
  created_at: string
}

export interface DbConversation {
  id: string
  participant_a: string
  participant_b: string
  last_message: string | null
  last_message_at: string
  last_message_sender?: string | null
  last_message_type?: string | null
  created_at: string
  other_user?: DbUser
  unread_count?: number
}

export interface DbMessage {
  id: string
  conversation_id: string
  sender_id: string
  content: string
  type: 'text' | 'payment_sent' | 'payment_received'
  payment_amount: number | null
  payment_tx_hash: string | null
  token_symbol: string | null
  is_read: boolean
  created_at: string
  sender?: DbUser
}

export interface DbContact {
  id: string
  owner_id: string
  contact_id: string
  is_favorite: boolean
  created_at: string
  contact_user?: DbUser
}

// ─── USER SEARCH — single function used everywhere ───────────────────────────
/**
 * Search users by username, display name, OR wallet address.
 * Works for ALL user types: email, create-wallet, import-wallet.
 * Excludes the current user from results.
 */
export async function searchUsersDb(
  query: string,
  excludeUserId?: string
): Promise<DbUser[]> {
  const raw = query.trim()
  if (!raw) return []

  // Wallet address exact lookup (0x...)
  if (/^0x[0-9a-fA-F]{10,}$/.test(raw)) {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, display_name, email, wallet_address, avatar_url, created_at')
      .ilike('wallet_address', raw)
      .limit(5)
    if (error) { console.error('[Supabase] wallet search error:', error.message); return [] }
    const results = ((data || []) as DbUser[])
      .filter(u => excludeUserId ? u.id !== excludeUserId : true)
    return results
  }

  // Exact username lookup — requires full ".arc" suffix.
  // Only "sunil.arc" returns a result. "sunil", "sunil.ar", "sun" → [].
  // Strip leading @ then require .arc ending.
  const withArc = raw.toLowerCase().replace(/^@/, '')
  if (!withArc.endsWith('.arc')) return []

  const base = withArc.slice(0, -4).trim() // remove ".arc"
  if (!base) return []

  const { data, error } = await supabase
    .from('users')
    .select('id, username, display_name, email, wallet_address, avatar_url, created_at')
    .eq('username', base)
    .not('wallet_address', 'is', null)
    .neq('wallet_address', '')
    .limit(1)

  if (error) { console.error('[Supabase] searchUsersDb error:', error.code, error.message); return [] }
  const results = ((data || []) as DbUser[])
    .filter(u => excludeUserId ? u.id !== excludeUserId : true)
  return results
}

// ─── LIVE PARTIAL SEARCH — used by Send flow's "as you type" results ─────────
/**
 * Partial / prefix search by username or display name. Unlike searchUsersDb,
 * this does NOT require a full ".arc" suffix — "rah" matches "rahul", "rakesh", etc.
 * Used for the Send Payment recipient search-as-you-type list.
 */
export async function searchUsersPartialDb(
  query: string,
  excludeUserId?: string,
  limit = 6,
): Promise<DbUser[]> {
  const raw = query.trim()
  if (!raw) return []

  // Wallet address — exact lookup
  if (/^0x[0-9a-fA-F]{6,}$/.test(raw)) {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, display_name, email, wallet_address, avatar_url, created_at')
      .ilike('wallet_address', `${raw}%`)
      .limit(limit)
    if (error) { console.error('[Supabase] partial wallet search error:', error.message); return [] }
    return ((data || []) as DbUser[]).filter(u => excludeUserId ? u.id !== excludeUserId : true)
  }

  const term = raw.toLowerCase().replace(/^@/, '').replace(/\.arc$/, '').trim()
  if (!term) return []

  const { data, error } = await supabase
    .from('users')
    .select('id, username, display_name, email, wallet_address, avatar_url, created_at')
    .or(`username.ilike.${term}%,display_name.ilike.${term}%`)
    .not('wallet_address', 'is', null)
    .neq('wallet_address', '')
    .limit(limit)

  if (error) { console.error('[Supabase] searchUsersPartialDb error:', error.code, error.message); return [] }
  return ((data || []) as DbUser[]).filter(u => excludeUserId ? u.id !== excludeUserId : true)
}

// ─── USER PROFILE ─────────────────────────────────────────────────────────────
export async function upsertUserProfile(params: {
  id: string
  email: string
  username: string
  displayName: string
  walletAddress: string
  loginType?: 'social' | 'wallet'
}): Promise<{ error: string | null }> {

  // loginType is included only when the caller actually knows it, via a
  // conditional spread — omitting the key on upsert leaves any existing
  // value alone rather than overwriting it with null. See
  // supabase/migrations/20260722100000_*.sql for why this column exists:
  // it's what lets the wallet-key Edge Function tell a self-custodial
  // account apart from a social-login one server-side.
  const loginTypeField = params.loginType ? { login_type: params.loginType } : {}

  // Use onConflict: 'username' as fallback in case id conflicts
  const { error } = await supabase.from('users').upsert({
    id: params.id,
    email: params.email.toLowerCase().trim(),
    username: params.username.toLowerCase().replace(/\.arc$/, '').trim(),
    display_name: params.displayName.trim() || params.username,
    wallet_address: params.walletAddress.toLowerCase(),
    avatar_url: null,
    ...loginTypeField,
  }, { onConflict: 'id' })

  if (error) {
    console.error('[Supabase] upsertUserProfile error:', error.code, error.message)
    // If id conflict (rare), try upsert by username
    if (error.code === '23505') {
      const { error: e2 } = await supabase.from('users').upsert({
        id: params.id,
        email: params.email.toLowerCase().trim(),
        username: params.username.toLowerCase().replace(/\.arc$/, '').trim(),
        display_name: params.displayName.trim() || params.username,
        wallet_address: params.walletAddress.toLowerCase(),
        avatar_url: null,
        ...loginTypeField,
      }, { onConflict: 'username' })
      if (e2) return { error: e2.message }
      return { error: null }
    }
    return { error: error.message }
  }

  return { error: null }
}

export async function updateUserProfile(params: {
  id: string
  displayName?: string
  avatarUrl?: string | null
  walletAddress?: string
}): Promise<{ error: string | null }> {
  const updates: Record<string, any> = {}
  if (params.displayName !== undefined) updates.display_name = params.displayName.trim()
  if (params.avatarUrl !== undefined) updates.avatar_url = params.avatarUrl


  // Try by id first (social login users have real Supabase UUIDs)
  if (params.id && !params.id.startsWith('usr_')) {
    const { data, error } = await supabase.from('users').update(updates).eq('id', params.id).select('id')
    if (!error) return { error: null }
  }

  // Fallback: update by wallet_address
  if (params.walletAddress) {
    const addr = params.walletAddress.toLowerCase()
    // First check what row exists
    const { data: existing } = await supabase.from('users')
      .select('id, wallet_address, avatar_url')
      .or(`wallet_address.eq.${addr},wallet_address.ilike.${params.walletAddress}`)
      .maybeSingle()

    if (existing) {
      // Update using the exact id from the found row
      const { data, error } = await supabase.from('users')
        .update(updates).eq('id', existing.id).select('id')
      if (!error) return { error: null }
      return { error: error.message }
    }

    // Row not found — upsert it
    const { error: upsertErr } = await supabase.from('users').upsert({
      id: params.id,
      wallet_address: addr,
      ...updates,
    }, { onConflict: 'id' })
    if (upsertErr) console.error('[updateUserProfile] upsert failed:', upsertErr.message)
    return { error: upsertErr?.message ?? null }
  }

  // Last resort: by id
  const { data, error } = await supabase.from('users').update(updates).eq('id', params.id).select('id')
  if (error) return { error: error.message }
  return { error: null }
}

export async function getAvatarByWallet(walletAddress: string): Promise<string | null> {
  const addr = walletAddress.toLowerCase()
  const { data } = await supabase
    .from('users')
    .select('avatar_url')
    .or(`wallet_address.eq.${addr},wallet_address.ilike.${walletAddress}`)
    .maybeSingle()
  return data?.avatar_url ?? null
}

// Security-audit note: every users-table select below is an explicit column
// list — id, username, display_name, email, wallet_address, avatar_url,
// created_at — matching DbUser exactly, rather than select('*'). This is
// deliberate, not stylistic: the users table also holds encrypted_wallet_key
// and wallet_auth_share (the social-login wallet vault — see wallet-key
// Edge Function), which the app never needs client-side and which now have
// a column-level REVOKE from anon/authenticated (service_role, used only by
// that Edge Function, is unaffected). A select('*') here would need those
// two columns too and fail outright post-REVOKE — keep every users query
// on an explicit allowlist, not '*', so this stays true.
export async function fetchUserProfile(userId: string): Promise<DbUser | null> {
  const { data, error } = await supabase
    .from('users')
    .select('id, username, display_name, email, wallet_address, avatar_url, created_at')
    .eq('id', userId)
    .maybeSingle()
  if (error) { console.error('[Supabase] fetchUserProfile:', error.message); return null }
  return data as DbUser | null
}

export async function fetchUserByEmail(email: string): Promise<DbUser | null> {
  const { data } = await supabase
    .from('users').select('id, username, display_name, email, wallet_address, avatar_url, created_at')
    .eq('email', email.toLowerCase()).maybeSingle()
  return data as DbUser | null
}

export async function getUserByUsername(username: string): Promise<DbUser | null> {
  const name = username.toLowerCase().replace(/\.arc$/, '').trim()
  const { data } = await supabase
    .from('users').select('id, username, display_name, email, wallet_address, avatar_url, created_at').eq('username', name).maybeSingle()
  return data as DbUser | null
}

export async function resolveUsernameDb(username: string): Promise<string | null> {
  const name = username.toLowerCase().replace(/^@/, '').replace(/\.arc$/, '').trim()
  const { data } = await supabase
    .from('users').select('wallet_address').eq('username', name).maybeSingle()
  if (!data?.wallet_address) return null
  return data.wallet_address
}

export async function isUsernameTakenDb(username: string): Promise<boolean> {
  const name = username.toLowerCase().replace(/\.arc$/, '').trim()
  const { data } = await supabase
    .from('users').select('username').eq('username', name).maybeSingle()
  return !!data
}

// saveWalletToCloud() used to live here — removed along with the two
// server-side backup columns it wrote to (encrypted_private_key,
// mnemonic_hint). MeshPort no longer stores private keys or recovery
// phrases server-side, in any form. See restoreWallet.ts for the
// local-only recovery paths this was replaced by, and the migration that
// dropped those columns for the full reasoning.

// ─── CONTACTS ─────────────────────────────────────────────────────────────────
/**
 * Add a contact to Supabase. Falls back to localStorage if no session.
 */
export async function addContactDb(
  ownerId: string,
  contactId: string
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('contacts')
    .upsert({ owner_id: ownerId, contact_id: contactId }, { onConflict: 'owner_id,contact_id' })
  if (error) { console.error('[Supabase] addContactDb:', error.message); return { error: error.message } }
  return { error: null }
}

/**
 * Save someone as a contact if they aren't already one — safe to call on
 * every successful payment (send or receive-then-reply). Checks for an
 * existing row first, so this never creates duplicates no matter how many
 * times you pay the same person.
 */
export async function upsertContactDb(ownerId: string, contactId: string): Promise<void> {
  if (!ownerId || !contactId || ownerId === contactId) return
  try {
    const { data: existing } = await supabase
      .from('contacts')
      .select('owner_id')
      .eq('owner_id', ownerId)
      .eq('contact_id', contactId)
      .maybeSingle()
    if (existing) return // already a saved contact — nothing to do

    const { error } = await supabase
      .from('contacts')
      .insert({ owner_id: ownerId, contact_id: contactId, is_favorite: false })
    if (error) console.error('[Supabase] upsertContactDb insert:', error.message)
  } catch (e) {
    console.error('[Supabase] upsertContactDb:', e)
  }
}

/**
 * Fetch all contacts for a user with full profile data.
 */
export async function fetchContactsDb(ownerId: string): Promise<DbUser[]> {
  // Get contact IDs
  const { data: contactRows, error } = await supabase
    .from('contacts')
    .select('contact_id, is_favorite')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false })

  if (error) { console.error('[Supabase] fetchContactsDb:', error.message); return [] }
  if (!contactRows || contactRows.length === 0) return []

  const ids = contactRows.map((r: any) => r.contact_id)

  // Fetch user profiles for those IDs
  const { data: users, error: usersError } = await supabase
    .from('users')
    .select('id, username, display_name, email, wallet_address, avatar_url, created_at')
    .in('id', ids)

  if (usersError) { console.error('[Supabase] fetchContactsDb users:', usersError.message); return [] }
  return (users || []) as DbUser[]
}

/**
 * Remove a contact from Supabase.
 */
export async function removeContactDb(ownerId: string, contactId: string): Promise<void> {
  await supabase.from('contacts').delete()
    .eq('owner_id', ownerId).eq('contact_id', contactId)
}

// ─── CHAT ─────────────────────────────────────────────────────────────────────
export async function getOrCreateConversation(
  myId: string,
  otherId: string
): Promise<{ id: string; error: string | null }> {
  // READ — works fine with sb_publishable_ key (SELECTs don't need auth)
  const { data: existing } = await supabase
    .from('conversations')
    .select('id')
    .or(`and(participant_a.eq.${myId},participant_b.eq.${otherId}),and(participant_a.eq.${otherId},participant_b.eq.${myId})`)
    .maybeSingle()

  if (existing?.id) return { id: existing.id, error: null }

  // INSERT — use server API (service key) as primary
  try {
    const res = await fetch('/api/chat?action=create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantA: myId, participantB: otherId }),
    })
    const json = await res.json().catch(() => ({}))
    if (res.ok && json?.id) return { id: json.id, error: null }
  } catch (e: any) {
  }

  // Fallback: direct Supabase client (works if user has valid auth session)
  await ensureAnonSession()
  const { data, error } = await supabase
    .from('conversations')
    .insert({ participant_a: myId, participant_b: otherId })
    .select('id').single()

  if (error) return { id: '', error: error.message }
  return { id: data.id, error: null }
}

// Short-lived cache shared across every caller of fetchConversations (Chats
// list, Chats' own contacts sheet, Send/"Pay on Arc"'s contacts list, etc).
// Without this, navigating between pages that each independently need "who
// have I talked to" data re-runs the full batched query from scratch on
// every single page visit, even seconds after another page just fetched the
// identical result — which is what made Pay on Arc's contacts list and the
// Chats contacts sheet both feel slow to open. Realtime subscriptions (in
// ChatListPage) handle true live-freshness already, so a short TTL here is
// safe: it only avoids *redundant* re-fetching on quick page hops, it
// doesn't replace live updates.
let _convCache: { key: string; data: DbConversation[]; ts: number } | null = null
const CONV_CACHE_TTL_MS = 15_000

export async function fetchConversations(myId: string): Promise<DbConversation[]> {
  const now = Date.now()
  if (_convCache && _convCache.key === myId && now - _convCache.ts < CONV_CACHE_TTL_MS) {
    return _convCache.data
  }

  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .or(`participant_a.eq.${myId},participant_b.eq.${myId}`)
    .order('last_message_at', { ascending: false })

  if (error || !data || data.length === 0) return []

  // ── Batched enrichment ──────────────────────────────────────────────────
  // Previously this ran 3 separate queries PER conversation (other-user
  // lookup, unread count, last-messages window) inside a Promise.all over
  // all conversations — so with N conversations that's 3×N round trips
  // fanning out simultaneously, which is what made the Chats list slow to
  // open (browsers also cap concurrent connections per host, so most of
  // those requests queue behind each other rather than truly running in
  // parallel). Batching into exactly 3 queries total, regardless of how
  // many conversations there are, fixes that.
  const convIds = data.map((c: any) => c.id)
  const otherIdByConv = new Map<string, string>(
    data.map((c: any) => [c.id, c.participant_a === myId ? c.participant_b : c.participant_a]),
  )
  const otherIds = Array.from(new Set(otherIdByConv.values()))

  const [usersRes, unreadRes, msgsRes] = await Promise.all([
    supabase.from('users').select('id, username, display_name, email, wallet_address, avatar_url, created_at').in('id', otherIds),
    supabase.from('messages').select('conversation_id, sender_id')
      .in('conversation_id', convIds).eq('is_read', false),
    // Fetches a shared window across all conversations (not just 1 each) so
    // the preview can still skip past a "Delete for everyone"'d message and
    // fall back to the last real message underneath it, same as before —
    // just batched instead of one query per conversation.
    supabase.from('messages').select('conversation_id, sender_id, type, content, created_at')
      .in('conversation_id', convIds)
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(convIds.length * 10, 100), 1000)),
  ])

  const usersById = new Map((usersRes.data || []).map((u: any) => [u.id, u]))

  // Unread count only counts messages sent BY the other participant that I
  // haven't read — filter client-side since the batched query above can't
  // express a per-row "sender must equal that row's other participant"
  // condition in a single request.
  //
  // BUG FIX (2026-09-03): a self-conversation (paying/messaging your own
  // username — participant_a === participant_b === myId) has otherId ===
  // myId, so EVERY message in it — including the payment_received leg,
  // whose sender_id is deliberately rewritten to the recipient's id by
  // /api/send-message.ts (see the comment on trueSender below) — passes
  // `row.sender_id === otherId` and gets counted as unread. Worse,
  // markMessagesRead's own query (`sender_id=neq.${myId}`) matches ZERO
  // rows in a self-chat for the exact same reason, so these messages can
  // NEVER be marked read — the count only ever grows, one more unread
  // message per self-payment, forever. This is the real cause of a
  // self-chat showing a large, permanently-climbing unread badge (e.g.
  // "29") even though there is no one else who could have sent something
  // still unread. A self-chat is forced to 0 unread here — there is no
  // "other party" a self-chat's badge could meaningfully represent.
  const unreadByConv = new Map<string, number>()
  for (const row of unreadRes.data || []) {
    const otherId = otherIdByConv.get(row.conversation_id)
    if (otherId === myId) continue // self-chat — never counts as unread, see above
    if (row.sender_id !== otherId) continue
    unreadByConv.set(row.conversation_id, (unreadByConv.get(row.conversation_id) || 0) + 1)
  }

  const msgsByConv = new Map<string, any[]>()
  for (const row of msgsRes.data || []) {
    const arr = msgsByConv.get(row.conversation_id) || []
    if (arr.length < 20) arr.push(row)   // rows already arrive newest-first
    msgsByConv.set(row.conversation_id, arr)
  }

  const enriched = data.map((conv: any) => {
    const otherId = otherIdByConv.get(conv.id)!
    const otherUser = usersById.get(otherId)
    const lastMsgRows = msgsByConv.get(conv.id) || []
    const trueLatest = lastMsgRows[0]
    const previewMsg  = lastMsgRows.find(m => m.content !== '[deleted]') ?? trueLatest

    // IMPORTANT: for type === 'payment_received' rows, `sender_id` is
    // intentionally set to the RECIPIENT's id by /api/send-message.ts (a
    // view-filtering convention, not the literal sender of the payment).
    // Resolve the TRUE sender so Sent/Received never inverts.
    let trueSender: string | null = previewMsg?.sender_id ?? null
    if (previewMsg?.type === 'payment_received' && trueSender) {
      trueSender = conv.participant_a === trueSender ? conv.participant_b : conv.participant_a
    }

    const userWithFreshAvatar = otherUser && otherUser.avatar_url
      ? { ...otherUser, avatar_url: otherUser.avatar_url.split('?')[0] }
      : otherUser

    return {
      ...conv,
      other_user: userWithFreshAvatar,
      unread_count: unreadByConv.get(conv.id) || 0,
      last_message: previewMsg?.content ?? conv.last_message,
      last_message_at: trueLatest?.created_at ?? conv.last_message_at,
      last_message_sender: trueSender,
      last_message_type: previewMsg?.type ?? null,
    }
  })

  // Re-sort using the fresh, live-queried timestamps above — the initial SQL
  // ORDER BY used conv.last_message_at, which can be stale for the same race
  // reason, so it isn't trustworthy for final ordering.
  enriched.sort((a: any, b: any) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime())
  _convCache = { key: myId, data: enriched, ts: Date.now() }
  return enriched
}

/** Call after any action that changes conversation membership/messages in a
 * way the next fetchConversations call must see immediately (e.g. right
 * after sending the very first message in a brand-new conversation) —
 * clears the short-lived cache above so the next call does a real fetch
 * instead of returning a stale pre-existing snapshot. */
export function invalidateConversationsCache() {
  _convCache = null
}

export async function fetchMessages(conversationId: string, limit = 50): Promise<DbMessage[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('*, sender:sender_id(id, username, display_name, avatar_url)')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error || !data) return []
  return data as DbMessage[]
}

export async function sendMessage(params: {
  conversationId: string
  senderId: string
  content: string
  type?: 'text' | 'payment_sent' | 'payment_received'
  paymentAmount?: number
  paymentTxHash?: string
  tokenSymbol?: string
}): Promise<{ data: DbMessage | null; error: string | null }> {
  const row = {
    conversation_id: params.conversationId,
    sender_id:       params.senderId,
    content:         params.content,
    type:            params.type ?? 'text',
    payment_amount:  params.paymentAmount  ?? null,
    payment_tx_hash: params.paymentTxHash  ?? null,
    token_symbol:    params.tokenSymbol    ?? 'USDC',
    is_read:         false,
  }

  const updateConv = () => supabase.from('conversations').update({
    last_message:    params.content,
    last_message_at: new Date().toISOString(),
  }).eq('id', params.conversationId).then(() => {})

  // ── PRIMARY: Server API with service role key (bypasses all auth/RLS issues) ──
  // sb_publishable_ anon keys (new 2025 format) don't work for client-side inserts
  // without a valid auth session. The server API uses the service role JWT which always works.
  try {
    const res = await fetch('/api/chat?action=send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId:  params.conversationId,
        senderId:        params.senderId,
        content:         params.content,
        type:            params.type ?? 'text',
        paymentAmount:   params.paymentAmount  ?? null,
        paymentTxHash:   params.paymentTxHash  ?? null,
        tokenSymbol:     params.tokenSymbol    ?? 'USDC',
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (res.ok && json?.data) {
      updateConv()
      return { data: json.data as DbMessage, error: null }
    }
  } catch (e: any) {
  }

  // ── FALLBACK 1: Supabase JS client (works if user has OTP session) ────────
  await ensureAnonSession()
  const { data, error } = await supabase.from('messages').insert(row).select().single()
  if (!error && data) {
    updateConv()
    return { data: data as DbMessage, error: null }
  }

  // ── FALLBACK 2: Direct REST fetch with anon key ───────────────────────────
  const restResult = await restInsertMessage(row)
  if (!restResult.error && restResult.data) {
    updateConv()
    return restResult
  }

  console.error('[sendMessage] All paths failed:', restResult.error ?? error?.message)
  return { data: null, error: restResult.error ?? error?.message ?? 'Send failed' }
}

export async function markMessagesRead(conversationId: string, myId: string): Promise<void> {
  // Use direct REST with service key — client-side UPDATE fails with sb_publishable_ key
  try {
    const url  = (import.meta.env.VITE_SUPABASE_URL as string) || ''
    const akey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || ''
    // Same self-chat fix as chatService.ts's markRead (the function actually
    // in use) — `sender_id=neq.${myId}` matches zero rows in a self-chat
    // (participant_a === participant_b === myId), since every message's
    // sender_id, including the recipient-rewritten payment_received leg,
    // equals myId there too. Kept in sync so this dead-but-still-exported
    // function can't reintroduce the same bug if it's ever wired up again.
    let isSelfChat = false
    try {
      const res = await fetch(
        `${url}/rest/v1/conversations?id=eq.${conversationId}&select=participant_a,participant_b`,
        { headers: { apikey: akey, Authorization: `Bearer ${akey}` } },
      )
      const rows = await res.json().catch(() => [])
      const conv = Array.isArray(rows) ? rows[0] : null
      isSelfChat = !!conv && conv.participant_a === conv.participant_b
    } catch { /* fall through */ }

    const senderFilter = isSelfChat ? '' : `&sender_id=neq.${myId}`
    await fetch(
      `${url}/rest/v1/messages?conversation_id=eq.${conversationId}${senderFilter}&is_read=eq.false`,
      {
        method: 'PATCH',
        headers: {
          'apikey':        akey,
          'Authorization': `Bearer ${akey}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=minimal',
        },
        body: JSON.stringify({ is_read: true }),
      }
    )
  } catch {
    // Non-critical — just fall through if it fails
  }
}

// ─── Lookup profile by wallet address ─────────────────────────────────────────
/** The single source of truth for wallet ownership.
 *  Checks Supabase by wallet_address — works for ALL user types. */
export async function getUserByWalletAddress(walletAddress: string): Promise<DbUser | null> {
  const addr = walletAddress.toLowerCase()
  const { data, error } = await supabase
    .from('users')
    .select('id, username, display_name, email, wallet_address, avatar_url, created_at')
    .ilike('wallet_address', addr)
    .maybeSingle()
  if (error) { console.error('[Supabase] getUserByWalletAddress:', error.message); return null }
  return data as DbUser | null
}

/** Batch lookup — fetch multiple users by wallet address in one query */
export async function getUsersByWalletAddresses(addresses: string[]): Promise<Map<string, DbUser>> {
  if (!addresses.length) return new Map()
  // Use supabase REST with ilike per-address — batch via or() filter
  const addrs = addresses.map(a => a.toLowerCase())
  // Build OR filter: wallet_address.ilike.0x1a2b,wallet_address.ilike.0x3c4d
  const orFilter = addrs.map(a => `wallet_address.ilike.${a}`).join(',')
  const { data, error } = await supabase
    .from('users').select('id, username, display_name, email, wallet_address, avatar_url, created_at')
    .or(orFilter)
  if (error) { console.error('[Supabase] getUsersByWalletAddresses:', error.message); return new Map() }
  const map = new Map<string, DbUser>()
  for (const u of (data || [])) map.set((u.wallet_address || '').toLowerCase(), u as DbUser)
  return map
}

// ─── Rewards ──────────────────────────────────────────────────────────────────
export interface DbReward {
  id: string
  title: string
  description: string
  reward_type: string
  reward_amount: number
  reward_token: string
  claim_type: 'one_time' | 'daily' | 'unlimited'
  active: boolean
  created_at: string
}

export interface DbRewardClaim {
  id: string
  user_id: string
  wallet_address: string
  reward_id: string
  amount: number
  reward_token: string
  status: string
  tx_hash: string | null
  claimed_at: string
}

/** Fetch all active rewards */
export async function fetchRewards(): Promise<DbReward[]> {
  const { data, error } = await supabase
    .from('rewards').select('*').eq('active', true).order('created_at')
  if (error) { console.error('[Supabase] fetchRewards:', error.message); return [] }
  return (data || []) as DbReward[]
}

/** Fetch all claims for a user */
export async function fetchUserClaims(userId: string): Promise<DbRewardClaim[]> {
  const { data, error } = await supabase
    .from('reward_claims').select('*')
    .eq('user_id', userId).order('claimed_at', { ascending: false })
  if (error) { console.error('[Supabase] fetchUserClaims:', error.message); return [] }
  return (data || []) as DbRewardClaim[]
}

/** Claim a reward — returns error string or null on success */
export async function claimReward(params: {
  userId: string
  walletAddress: string
  rewardId: string
}): Promise<{ error: string | null; claim: DbRewardClaim | null }> {
  // 1. Fetch the reward
  const { data: reward, error: rErr } = await supabase
    .from('rewards').select('*').eq('id', params.rewardId).single()
  if (rErr || !reward) return { error: 'Reward not found', claim: null }
  if (!reward.active)   return { error: 'This reward is no longer active', claim: null }

  // 2. Check duplicate claims
  if (reward.claim_type === 'one_time') {
    const { data: existing } = await supabase
      .from('reward_claims').select('id')
      .eq('user_id', params.userId).eq('reward_id', params.rewardId).maybeSingle()
    if (existing) return { error: 'You have already claimed this reward', claim: null }
  }

  if (reward.claim_type === 'daily') {
    const today = new Date().toISOString().split('T')[0]
    const { data: todayClaim } = await supabase
      .from('reward_claims').select('id')
      .eq('user_id', params.userId).eq('reward_id', params.rewardId)
      .gte('claimed_at', today + 'T00:00:00Z').maybeSingle()
    if (todayClaim) return { error: 'Already claimed today — come back tomorrow', claim: null }
  }

  // 3. Create claim record
  const { data: claim, error: cErr } = await supabase
    .from('reward_claims').insert({
      user_id: params.userId,
      wallet_address: params.walletAddress,
      reward_id: params.rewardId,
      amount: reward.reward_amount,
      reward_token: reward.reward_token,
      status: 'completed',
    }).select().single()

  if (cErr) {
    console.error('[Supabase] claimReward insert:', cErr.message)
    return { error: 'Failed to record claim: ' + cErr.message, claim: null }
  }

  return { error: null, claim: claim as DbRewardClaim }
}

// ─── TRANSACTIONS — source of truth for Activity page ─────────────────────────
// Written immediately after every successful on-chain send.
// Read by activityService to populate the Activity page.
// No dependency on ArcScan indexing — appears instantly after payment.

export interface DbTransaction {
  id:               string
  type:             'sent' | 'received' | 'multichain' | 'bulk_payment'
  status:           'completed' | 'pending' | 'failed'
  amount:           number
  usd_value:        number
  sender_address:   string
  receiver_address: string
  tx_hash:          string | null
  note:             string | null
  fee:              number | null
  created_at:       string
}

export async function saveTransaction(params: {
  id:              string
  type:            DbTransaction['type']
  status:          DbTransaction['status']
  amount:          number
  senderAddress:   string
  receiverAddress: string
  txHash:          string
  note?:           string
  fee?:            number
}): Promise<void> {
  const { error } = await supabase.from('transactions').upsert({
    id:               params.id,
    type:             params.type,
    status:           params.status ?? 'completed',
    amount:           params.amount,
    usd_value:        params.amount,
    sender_address:   params.senderAddress.toLowerCase(),
    receiver_address: params.receiverAddress.toLowerCase(),
    tx_hash:          params.txHash || null,
    note:             params.note || null,
    fee:              params.fee ?? null,
  }, { onConflict: 'id' })
  if (error) console.error('[saveTransaction] error:', error.code, error.message)
}

// ─── TRANSACTION NOTES — source/note metadata keyed by txHash ──────────────
// Lightweight table: tx_hash (PK), sender_address, receiver_address, source, note
// Queried by activityService to enrich RPC records with context.

export async function saveTransactionNote(params: {
  txHash:          string
  senderAddress:   string
  receiverAddress: string
  source:          'send' | 'chat' | 'bulk' | 'multichain'
  note?:           string
}): Promise<void> {
  const { error } = await supabase.from('transaction_notes').upsert({
    tx_hash:          params.txHash.toLowerCase(),
    sender_address:   params.senderAddress.toLowerCase(),
    receiver_address: params.receiverAddress.toLowerCase(),
    source:           params.source,
    note:             params.note ?? null,
  }, { onConflict: 'tx_hash' })
  if (error) {
    if (!error.message?.includes('does not exist')) {
    }
  }
}

export interface TransactionNote {
  txHash:          string
  source:          string
  note:            string | null
  senderAddress:   string
  receiverAddress: string
}

export async function fetchTransactionNotes(
  walletAddress: string,
): Promise<Map<string, TransactionNote>> {
  const addr = walletAddress.toLowerCase()
  const { data, error } = await supabase
    .from('transaction_notes')
    .select('tx_hash, source, note, sender_address, receiver_address, created_at')
    .or(`sender_address.eq.${addr},receiver_address.eq.${addr}`)
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) {
    // Table may not exist yet — fail silently, notes are optional
    if (!error.message?.includes('does not exist')) {
    }
    return new Map()
  }
  const map = new Map<string, TransactionNote>()
  for (const r of (data ?? [])) {
    map.set(r.tx_hash, {
      txHash:          r.tx_hash,
      source:          r.source,
      note:            r.note,
      senderAddress:   r.sender_address,
      receiverAddress: r.receiver_address,
    })
  }
  return map
}

export async function fetchTransactions(walletAddress: string, limit = 100): Promise<DbTransaction[]> {
  const addr = walletAddress.toLowerCase()
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .or(`sender_address.eq.${addr},receiver_address.eq.${addr}`)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) { console.error('[fetchTransactions] error:', error.code, error.message); return [] }
  return (data ?? []) as DbTransaction[]
}

// ─── MULTICHAIN TRANSACTIONS — persistent cross-device classification ──────────
// Written by MultichainClaimPage and MultichainTransferPage on every successful
// bridge/claim operation. Read by activityService to classify Transfer logs
// as 'multichain' instead of 'received'. Works on any device after login.

export async function saveMultichainTx(params: {
  txHash:        string
  walletAddress: string
  type:          'claim' | 'deposit' | 'bridge'
  amount?:       number
  sourceChain?:  string
  destChain?:    string
}): Promise<void> {
  const { error } = await supabase.from('multichain_transactions').upsert({
    tx_hash:        params.txHash.toLowerCase(),
    wallet_address: params.walletAddress.toLowerCase(),
    type:           params.type,
    amount:         params.amount ?? null,
    source_chain:   params.sourceChain ?? null,
    dest_chain:     params.destChain ?? null,
  }, { onConflict: 'tx_hash' })
  if (error) console.error('[Supabase] saveMultichainTx error:', error.message)
}

export async function fetchMultichainTxHashes(walletAddress: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('multichain_transactions')
    .select('tx_hash')
    .eq('wallet_address', walletAddress.toLowerCase())
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) {
    console.error('[Supabase] fetchMultichainTxHashes error:', error.message)
    return new Set()
  }
  return new Set((data ?? []).map((r: any) => r.tx_hash))
}

// Returns full rows for deposit/bridge txs — used to show them in Activity
// even though they happened on external chains (not visible in Arc eth_getLogs)
export interface MultichainTxRecord {
  txHash:      string
  type:        'claim' | 'deposit' | 'bridge'
  amount:      number | null
  sourceChain: string | null
  destChain:   string | null
  createdAt:   string
}

export async function fetchMultichainTxRecords(
  walletAddress: string,
): Promise<MultichainTxRecord[]> {
  const { data, error } = await supabase
    .from('multichain_transactions')
    .select('tx_hash, type, amount, source_chain, dest_chain, created_at')
    .eq('wallet_address', walletAddress.toLowerCase())
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) {
    console.error('[Supabase] fetchMultichainTxRecords error:', error.message)
    return []
  }
  return (data ?? []).map((r: any) => ({
    txHash:      r.tx_hash,
    type:        r.type,
    amount:      r.amount != null ? parseFloat(r.amount) : null,
    sourceChain: r.source_chain ?? null,
    destChain:   r.dest_chain   ?? null,
    createdAt:   r.created_at,
  }))
}

// ── Swap history (cross-device) ───────────────────────────────────────────────
// Stored in multichain_transactions with type='swap'.
// source_chain = tokenIn, dest_chain = tokenOut for easy filtering.

export async function saveSwapTx(params: {
  txHash:      string
  walletAddress: string
  tokenIn:     string
  tokenOut:    string
  amountIn:    string
  amountOut:   string
  status:      'success' | 'failed'
}): Promise<void> {
  const { error } = await supabase.from('multichain_transactions').upsert({
    tx_hash:        params.txHash.toLowerCase(),
    wallet_address: params.walletAddress.toLowerCase(),
    type:           'swap',
    amount:         parseFloat(params.amountIn) || null,
    source_chain:   params.tokenIn,   // repurposed: tokenIn
    dest_chain:     params.tokenOut,  // repurposed: tokenOut
    // store amountOut + status in note field as JSON
    note:           JSON.stringify({ amountOut: params.amountOut, status: params.status }),
  }, { onConflict: 'tx_hash' })
  if (error) console.error('[Supabase] saveSwapTx error:', error.message)
}

export interface SwapTxRecord {
  txHash:    string
  tokenIn:   string
  tokenOut:  string
  amountIn:  string
  amountOut: string
  status:    'success' | 'failed'
  timestamp: number
}

export async function fetchSwapRecords(walletAddress: string): Promise<SwapTxRecord[]> {
  const { data, error } = await supabase
    .from('multichain_transactions')
    .select('tx_hash, source_chain, dest_chain, amount, note, created_at')
    .eq('wallet_address', walletAddress.toLowerCase())
    .eq('type', 'swap')
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) { console.error('[Supabase] fetchSwapRecords error:', error.message); return [] }
  return (data ?? []).map((r: any) => {
    let amountOut = '0', status: 'success' | 'failed' = 'success'
    try { const n = JSON.parse(r.note || '{}'); amountOut = n.amountOut || '0'; status = n.status || 'success' } catch {}
    return {
      txHash:    r.tx_hash,
      tokenIn:   r.source_chain ?? '',
      tokenOut:  r.dest_chain ?? '',
      amountIn:  String(r.amount ?? '0'),
      amountOut,
      status,
      timestamp: new Date(r.created_at).getTime(),
    }
  })
}

// ── Support tickets — Help & Support ────────────────────────────────────────
export interface SupportTicket {
  id:          string
  subject:     string
  message:     string
  status:      'open' | 'in_progress' | 'resolved' | 'closed'
  adminReply:  string | null
  repliedAt:   string | null
  createdAt:   string
}

export async function submitSupportTicket(params: {
  userId:        string
  walletAddress: string | null
  email:         string | null
  username:      string | null
  subject:       string
  message:       string
}): Promise<{ success: boolean; error: string | null }> {
  const { error } = await supabase.from('support_tickets').insert({
    user_id:        params.userId,
    wallet_address: params.walletAddress,
    email:          params.email,
    username:       params.username,
    subject:        params.subject,
    message:        params.message,
  })
  if (error) { console.error('[Supabase] submitSupportTicket error:', error.message); return { success: false, error: error.message } }
  return { success: true, error: null }
}

export async function fetchMySupportTickets(userId: string): Promise<SupportTicket[]> {
  const { data, error } = await supabase
    .from('support_tickets')
    .select('id, subject, message, status, admin_reply, replied_at, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) { console.error('[Supabase] fetchMySupportTickets error:', error.message); return [] }
  return (data ?? []).map((r: any) => ({
    id:         r.id,
    subject:    r.subject,
    message:    r.message,
    status:     r.status,
    adminReply: r.admin_reply,
    repliedAt:  r.replied_at,
    createdAt:  r.created_at,
  }))
}

