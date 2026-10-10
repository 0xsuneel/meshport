// Chat privacy (Chats → your profile picture). Stored on your users row; the
// checks run in the database (supabase/migrations/20261010160000_chat_privacy.sql).
//
//   msgPrivacy        'everyone' | 'contacts'  - strangers' chats go to Requests
//   strangerPayments  'allow'    | 'block'     - MeshPort won't let a stranger
//                     pay you, and payments that arrive from outside MeshPort
//                     send no alert
//
// "Stranger" = not in your contacts and you've never messaged / paid them.
// Merchants always accept everyone.
import { supabase } from './supabase'

export type MsgPrivacy = 'everyone' | 'contacts'
export type StrangerPayments = 'allow' | 'block'
export type ChatPrivacy = { msgPrivacy: MsgPrivacy; strangerPayments: StrangerPayments }

const DEFAULTS: ChatPrivacy = { msgPrivacy: 'everyone', strangerPayments: 'allow' }
const key = (userId: string) => `meshport_chat_privacy_${userId}`

/** Last known settings on this device (instant), refreshed by fetchMyPrivacy. */
export function cachedPrivacy(userId: string | undefined | null): ChatPrivacy {
  if (!userId) return DEFAULTS
  try {
    const v = JSON.parse(localStorage.getItem(key(userId)) || 'null')
    return {
      msgPrivacy: v?.msgPrivacy === 'contacts' ? 'contacts' : 'everyone',
      strangerPayments: v?.strangerPayments === 'block' ? 'block' : 'allow',
    }
  } catch { return DEFAULTS }
}
function remember(userId: string, p: ChatPrivacy) {
  try { localStorage.setItem(key(userId), JSON.stringify(p)) } catch { /* private mode */ }
}

export async function fetchMyPrivacy(userId: string): Promise<ChatPrivacy> {
  const { data, error } = await supabase.from('users').select('msg_privacy, stranger_payments').eq('id', userId).maybeSingle()
  if (error || !data) return cachedPrivacy(userId)
  const p: ChatPrivacy = {
    msgPrivacy: data.msg_privacy === 'contacts' ? 'contacts' : 'everyone',
    strangerPayments: data.stranger_payments === 'block' ? 'block' : 'allow',
  }
  remember(userId, p)
  return p
}

export async function saveMyPrivacy(userId: string, patch: Partial<ChatPrivacy>): Promise<ChatPrivacy> {
  const next = { ...cachedPrivacy(userId), ...patch }
  const { error } = await supabase.from('users')
    .update({ msg_privacy: next.msgPrivacy, stranger_payments: next.strangerPayments })
    .eq('id', userId)
  if (error) throw error
  remember(userId, next)
  return next
}

/**
 * Before paying someone: may I? `canPay: false` means they only accept
 * payments from their contacts - nothing should be sent. Fails open (a
 * network error never blocks a payment to someone who allows everyone).
 */
export async function reachCheck(recipientId: string): Promise<{ canPay: boolean; toRequests: boolean }> {
  try {
    const { data, error } = await supabase.rpc('chat_reach_check', { recipient: recipientId })
    const row = Array.isArray(data) ? data[0] : data
    if (error || !row) return { canPay: true, toRequests: false }
    return { canPay: row.can_pay !== false, toRequests: row.to_requests === true }
  } catch { return { canPay: true, toRequests: false } }
}

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
