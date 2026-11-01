// lib/localChat.ts
//
// Device-only chat (owner's decision, 1 Nov): text, photos and files live on
// this phone, in IndexedDB - one database per MeshPort account. The server
// only passes a chat message along (chat_take_mail hands it over and deletes
// it - lib/chatMailbox.ts). Payment cards are not kept here: they stay in
// Supabase and are merged in by the screens, so payment history shows on
// every device.
//
// Messages are stored as received (end-to-end sealed, e2e:v2); they're opened
// with this device's chat key (lib/chatCrypto.ts).

import type { ChatMessage } from './chatService'

const DB_PREFIX = 'meshport-chat-'
const STORE = 'messages'
const BY_CONV = 'byConversation'
/** Fired on window after any change ({ conversationId }). */
export const LOCAL_CHAT_EVENT = 'meshport:local-chat'

const dbs = new Map<string, Promise<IDBDatabase>>()

function open(userId: string): Promise<IDBDatabase> {
  let p = dbs.get(userId)
  if (!p) {
    p = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_PREFIX + userId, 1)
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex(BY_CONV, ['conversation_id', 'created_at'])
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    p.catch(() => dbs.delete(userId))
    dbs.set(userId, p)
  }
  return p
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error) })
}
function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) })
}
function changed(conversationId: string | null): void {
  try { window.dispatchEvent(new CustomEvent(LOCAL_CHAT_EVENT, { detail: { conversationId } })) } catch { /* no window */ }
}

/** Chat rows only - payment cards and signals never go in here. */
export function isLocalKind(type: string | null | undefined): boolean {
  return type !== 'payment_sent' && type !== 'payment_received' && type !== 'signal'
}

/** Saves (or updates) messages; an existing message keeps its receipts unless the new copy has them. */
export async function putMessages(userId: string, rows: ChatMessage[]): Promise<void> {
  const keep = rows.filter(r => r?.id && isLocalKind(r.type))
  if (!keep.length) return
  const db = await open(userId)
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  // Read-then-write inside request callbacks: no await may run while the
  // transaction is open, or it commits early.
  for (const r of keep) {
    const { _failed, ...clean } = r
    void _failed
    const req = store.get(r.id)
    req.onsuccess = () => {
      const prev = req.result as ChatMessage | undefined
      store.put(prev ? { ...prev, ...clean, delivered_at: clean.delivered_at ?? prev.delivered_at ?? null, read_at: clean.read_at ?? prev.read_at ?? null, is_read: clean.is_read || prev.is_read } : clean)
    }
  }
  await done(tx)
  for (const c of new Set(keep.map(r => r.conversation_id))) changed(c)
}

/** Up to `limit` messages of a conversation, oldest first; `before` (created_at) pages back. */
export async function getMessages(userId: string, conversationId: string, limit = 50, before?: string): Promise<ChatMessage[]> {
  const db = await open(userId)
  const index = db.transaction(STORE).objectStore(STORE).index(BY_CONV)
  const upper = before ? [conversationId, before] : [conversationId, '￿']
  const range = IDBKeyRange.bound([conversationId, ''], upper, false, !!before)
  const out: ChatMessage[] = []
  await new Promise<void>((resolve, reject) => {
    const req = index.openCursor(range, 'prev')
    req.onsuccess = () => {
      const c = req.result
      if (!c || out.length >= limit) { resolve(); return }
      out.push(c.value as ChatMessage)
      c.continue()
    }
    req.onerror = () => reject(req.error)
  })
  return out.reverse()
}

/** Changes fields of stored messages by id (receipts, delete-for-everyone, reseal). */
export async function patchMessages(userId: string, ids: string[], patch: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>)): Promise<void> {
  if (!ids.length) return
  const db = await open(userId)
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  const convs = new Set<string>()
  for (const id of ids) {
    const req = store.get(id)
    req.onsuccess = () => {
      const m = req.result as ChatMessage | undefined
      if (!m) return
      const p = typeof patch === 'function' ? patch(m) : patch
      if (!Object.keys(p).length) return
      store.put({ ...m, ...p })
      convs.add(m.conversation_id)
    }
  }
  await done(tx)
  for (const c of convs) changed(c)
}

/** Removes messages from this phone ("delete for me"). */
export async function deleteMessages(userId: string, ids: string[]): Promise<void> {
  if (!ids.length) return
  const db = await open(userId)
  const tx = db.transaction(STORE, 'readwrite')
  for (const id of ids) tx.objectStore(STORE).delete(id)
  await done(tx)
  changed(null)
}

/** The other person's unread messages in a conversation, marked read here; returns their ids (for the read receipt). */
export async function markConversationRead(userId: string, conversationId: string, myIds: string[]): Promise<string[]> {
  const rows = await getMessages(userId, conversationId, 500)
  const unread = rows.filter(m => !m.is_read && !myIds.includes(m.sender_id))
  await patchMessages(userId, unread.map(m => m.id), { is_read: true, read_at: new Date().toISOString() })
  return unread.map(m => m.id)
}

export interface LocalSummary { last: ChatMessage | null; unread: number }

/** Per conversation: its latest message (not deleted) and how many of the other person's are unread. */
export async function summaries(userId: string, myIds: string[]): Promise<Map<string, LocalSummary>> {
  const db = await open(userId)
  const all = await result(db.transaction(STORE).objectStore(STORE).getAll()) as ChatMessage[]
  const out = new Map<string, LocalSummary>()
  for (const m of all) {
    const s = out.get(m.conversation_id) ?? { last: null, unread: 0 }
    if (!m.deleted_at && m.content !== '[deleted]' && (!s.last || m.created_at > s.last.created_at)) s.last = m
    if (!m.is_read && !myIds.includes(m.sender_id)) s.unread++
    out.set(m.conversation_id, s)
  }
  return out
}

/** All unread messages from others on this phone (the Chats badge). */
export async function unreadCount(userId: string, myIds: string[]): Promise<number> {
  let n = 0
  for (const s of (await summaries(userId, myIds)).values()) n += s.unread
  return n
}

/** Test hook: close and forget open connections. */
export function _resetLocalChat(): void {
  for (const p of dbs.values()) p.then(db => db.close()).catch(() => {})
  dbs.clear()
}
