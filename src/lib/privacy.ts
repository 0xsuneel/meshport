// Chat privacy (Chats → your profile picture). Stored on your users row; the
// checks run in the database (supabase/migrations/20261010160000_chat_privacy.sql).
//
//   msgPrivacy        'everyone' | 'contacts'  - strangers' chats go to Requests
//   strangerPayments  'allow'    | 'block'     - MeshPort won't let a stranger
//                     pay you, and payments that arrive from outside MeshPort
//                     send no alert
//   requestPrivacy    'everyone' | 'contacts'  - who may send you a payment
//                     request (chat Request / Receive → Request payment)
//
// "Stranger" = not in your contacts and you've never messaged / paid them.
// Merchants always accept everyone. Payment requests are only between
// people: merchants send Bills, and nobody can request from a merchant.
import { supabase } from './supabase'

export type MsgPrivacy = 'everyone' | 'contacts'
export type StrangerPayments = 'allow' | 'block'
export type RequestPrivacy = 'everyone' | 'contacts'
export type ChatPrivacy = { msgPrivacy: MsgPrivacy; strangerPayments: StrangerPayments; requestPrivacy: RequestPrivacy }

const DEFAULTS: ChatPrivacy = { msgPrivacy: 'everyone', strangerPayments: 'allow', requestPrivacy: 'everyone' }
const key = (userId: string) => `meshport_chat_privacy_${userId}`

/** Last known settings on this device (instant), refreshed by fetchMyPrivacy. */
export function cachedPrivacy(userId: string | undefined | null): ChatPrivacy {
  if (!userId) return DEFAULTS
  try {
    const v = JSON.parse(localStorage.getItem(key(userId)) || 'null')
    return {
      msgPrivacy: v?.msgPrivacy === 'contacts' ? 'contacts' : 'everyone',
      strangerPayments: v?.strangerPayments === 'block' ? 'block' : 'allow',
      requestPrivacy: v?.requestPrivacy === 'contacts' ? 'contacts' : 'everyone',
    }
  } catch { return DEFAULTS }
}
function remember(userId: string, p: ChatPrivacy) {
  try { localStorage.setItem(key(userId), JSON.stringify(p)) } catch { /* private mode */ }
}

export async function fetchMyPrivacy(userId: string): Promise<ChatPrivacy> {
  let { data, error } = await supabase.from('users').select('msg_privacy, stranger_payments, request_privacy').eq('id', userId).maybeSingle()
  // Before the request_privacy migration (20261011120000) the column isn't
  // there yet - still read the other two settings.
  if (error) ({ data, error } = await supabase.from('users').select('msg_privacy, stranger_payments').eq('id', userId).maybeSingle() as any)
  if (error || !data) return cachedPrivacy(userId)
  const p: ChatPrivacy = {
    msgPrivacy: data.msg_privacy === 'contacts' ? 'contacts' : 'everyone',
    strangerPayments: data.stranger_payments === 'block' ? 'block' : 'allow',
    requestPrivacy: data.request_privacy === 'contacts' ? 'contacts' : 'everyone',
  }
  remember(userId, p)
  return p
}

export async function saveMyPrivacy(userId: string, patch: Partial<ChatPrivacy>): Promise<ChatPrivacy> {
  const next = { ...cachedPrivacy(userId), ...patch }
  // Only the changed setting is written, so one setting can't fail because
  // of another's column.
  const cols: Record<string, string> = {}
  if (patch.msgPrivacy) cols.msg_privacy = patch.msgPrivacy
  if (patch.strangerPayments) cols.stranger_payments = patch.strangerPayments
  if (patch.requestPrivacy) cols.request_privacy = patch.requestPrivacy
  const { error } = await supabase.from('users').update(cols).eq('id', userId)
  if (error) throw error
  remember(userId, next)
  return next
}

/**
 * Before paying someone: may I? `canPay: false` means they only accept
 * payments from their contacts - nothing should be sent. Fails open (a
 * network error never blocks a payment to someone who allows everyone).
 * `canRequest: false` hides Request for them: they take requests from
 * contacts only, they blocked me, or one of us is a merchant. (The database
 * refuses such a request anyway, so failing open here is safe.)
 */
export type Reach = { canPay: boolean; toRequests: boolean; blocked: boolean; canRequest: boolean }
const OPEN: Reach = { canPay: true, toRequests: false, blocked: false, canRequest: true }
// A real answer is reused for a minute, and one already on its way is
// shared: the check made when the recipient is picked is the one the
// payment uses (it ran twice, and the payment waited for its own).
const REACH_TTL_MS = 60_000
const reachAnswers = new Map<string, { reach: Reach; at: number }>()
const reachRunning = new Map<string, Promise<Reach>>()

function fetchReach(recipientId: string): Promise<Reach> {
  const running = reachRunning.get(recipientId)
  if (running) return running
  const p = (async (): Promise<Reach> => {
    try {
      const { data, error } = await supabase.rpc('chat_reach_check', { recipient: recipientId })
      const row = Array.isArray(data) ? data[0] : data
      if (error || !row) return OPEN
      const reach = { canPay: row.can_pay !== false, toRequests: row.to_requests === true, blocked: row.blocked === true, canRequest: row.can_request !== false }
      reachAnswers.set(recipientId, { reach, at: Date.now() })
      return reach
    } catch { return OPEN }
  })().finally(() => reachRunning.delete(recipientId))
  reachRunning.set(recipientId, p)
  return p
}

/**
 * `maxWaitMs`: for a payment - never wait longer than this. No answer by
 * then is treated like a failed check (it fails open, as above): a payment
 * waited 11 s on it while the app was starting up. The check still finishes
 * in the background, so the next one has the answer.
 */
export async function reachCheck(recipientId: string, opts?: { maxWaitMs?: number }): Promise<Reach> {
  const hit = reachAnswers.get(recipientId)
  if (hit && Date.now() - hit.at < REACH_TTL_MS) return hit.reach
  const p = fetchReach(recipientId)
  if (!opts?.maxWaitMs) return p
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<Reach>(resolve => { timer = setTimeout(() => resolve(OPEN), opts.maxWaitMs) })
  try { return await Promise.race([p, late]) } finally { clearTimeout(timer) }
}

/** Payments wait at most this long for the privacy check (reachCheck). */
export const PAYMENT_REACH_WAIT_MS = 1500

/** Test hook. */
export function resetReachCache(): void { reachAnswers.clear(); reachRunning.clear() }

// ── Blocking (chat_blocks: yours only) ─────────────────────────────────────
// A blocked person can't message you (the database refuses it) or pay you
// in MeshPort ("<you> has blocked you"), and anything that still arrives
// from them comes without an alert.
export type BlockedPerson = { id: string; username: string; display_name: string | null; avatar_url: string | null }

export async function fetchBlocked(userId: string): Promise<BlockedPerson[]> {
  const { data, error } = await supabase.from('chat_blocks').select('blocked_id, created_at').eq('owner_id', userId).order('created_at', { ascending: false })
  if (error || !data?.length) return []
  const ids = data.map((r: any) => r.blocked_id)
  const { data: users } = await supabase.from('users').select('id, username, display_name, avatar_url').in('id', ids)
  const byId = new Map((users ?? []).map((u: any) => [u.id, u]))
  return ids.map(id => byId.get(id)).filter(Boolean) as BlockedPerson[]
}

// Wallets I've blocked → when (ms). Activity shows a payment from one of
// them after that moment as a bare address, without their username (it can
// only have come from outside MeshPort - see ActivityService.fetchActivity).
let _blockedWallets: { uid: string; at: number; map: Map<string, number> } | null = null
export function clearBlockedCache() { _blockedWallets = null }
export async function blockedWalletMap(userId: string): Promise<Map<string, number>> {
  if (_blockedWallets && _blockedWallets.uid === userId && Date.now() - _blockedWallets.at < 60_000) return _blockedWallets.map
  const map = new Map<string, number>()
  const { data } = await supabase.from('chat_blocks').select('blocked_id, created_at').eq('owner_id', userId)
  if (data?.length) {
    const when = new Map(data.map((r: any) => [r.blocked_id, new Date(r.created_at).getTime()]))
    const { data: users } = await supabase.from('users').select('id, wallet_address').in('id', [...when.keys()])
    for (const u of users ?? []) if (u.wallet_address) map.set(String(u.wallet_address).toLowerCase(), when.get(u.id) ?? 0)
  }
  _blockedWallets = { uid: userId, at: Date.now(), map }
  return map
}

/** Fired when which chats count as unread changes - I blocked, unblocked or
 *  accepted someone - so the Chats badge recounts (no message event says so). */
export const CHAT_COUNT_CHANGED_EVENT = 'meshport:chat-count-changed'
export const chatCountChanged = () => { try { window.dispatchEvent(new Event(CHAT_COUNT_CHANGED_EVENT)) } catch { /* no window (tests) */ } }

export async function blockUser(userId: string, otherId: string): Promise<void> {
  clearBlockedCache()
  reachAnswers.delete(otherId)
  const { error } = await supabase.from('chat_blocks').upsert({ owner_id: userId, blocked_id: otherId }, { onConflict: 'owner_id,blocked_id', ignoreDuplicates: true })
  if (error) throw error
  chatCountChanged()
}

export async function unblockUser(userId: string, otherId: string): Promise<void> {
  clearBlockedCache()
  reachAnswers.delete(otherId)
  const { error } = await supabase.from('chat_blocks').delete().eq('owner_id', userId).eq('blocked_id', otherId)
  if (error) throw error
  chatCountChanged()
}

export const BLOCKED_YOU = (name: string) => `${name} has blocked you. You can't message or pay them.`

/** My chats that are message requests (empty unless I chose Contacts only). */
export async function fetchMyRequestIds(): Promise<Set<string>> {
  const { data, error } = await supabase.rpc('chat_my_requests')
  if (error || !Array.isArray(data)) return new Set()
  return new Set(data.map((r: any) => (typeof r === 'string' ? r : r?.chat_my_requests)).filter(Boolean))
}

/** Should the alert for a payment from this wallet stay quiet (stranger, and I block them)? */
export async function quietFor(fromWallet: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('chat_quiet_for_me', { from_wallet: fromWallet })
    return !error && data === true
  } catch { return false }
}

export const STRANGER_PAY_BLOCKED = (name: string) => `${name} only accepts payments from their contacts.`
