// chatListCache.ts - the last Chats list that loaded, per account, so a fresh
// app open shows your chats at once (like WhatsApp / PhonePe) and refreshes
// in the background, instead of loading placeholders - ~8 s on a weak
// network, where the database client retries each failed read.
//
// Chat text is end-to-end sealed and kept sealed on this device
// (lib/localChat.ts). So a row keeps its preview only when it's sealed
// (e2e:…) - shown the same way as on a live list - or a payment card (which
// the server already holds as is). Anything else is dropped from the stored
// copy and shows once the list refreshes. Cleared on logout with the other
// per-account caches (store/index.ts, CHAT_LIST_CACHE_PREFIX).
import type { DbConversation } from './supabase'

export const CHAT_LIST_CACHE_PREFIX = 'meshport_chat_list_'
const MAX_ROWS = 100

const keepPreview = (c: DbConversation) =>
  typeof c.last_message === 'string' && (c.last_message.startsWith('e2e:') || c.last_message_type === 'payment_sent' || c.last_message_type === 'payment_received')

export function readChatListCache(userId: string | null | undefined): DbConversation[] | null {
  if (!userId) return null
  try {
    const raw = localStorage.getItem(CHAT_LIST_CACHE_PREFIX + userId)
    const v = raw ? JSON.parse(raw) : null
    return v && v.v === 1 && Array.isArray(v.list) ? (v.list as DbConversation[]) : null
  } catch { return null }
}

export function writeChatListCache(userId: string, list: DbConversation[]): void {
  if (!userId) return
  const rows = list.slice(0, MAX_ROWS).map(c => (keepPreview(c) ? c : { ...c, last_message: null }))
  try { localStorage.setItem(CHAT_LIST_CACHE_PREFIX + userId, JSON.stringify({ v: 1, at: Date.now(), list: rows })) } catch { /* storage full / blocked */ }
}
