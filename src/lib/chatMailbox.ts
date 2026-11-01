// lib/chatMailbox.ts
//
// Device-only chat: picks up the chat messages waiting for me on the server,
// saves them on this phone (lib/localChat.ts), then tells the server it has
// them - only then are they deleted there (chat_peek_mail / chat_ack_mail,
// migration 20261102100000_chat_device_only.sql). Like WhatsApp: the server
// holds a sealed message only until the recipient's phone has it.
//
// Receipts and "delete for everyone" come the same way as small 'signal'
// rows ({ kind, ids, at } - no content) and are applied to the copies here.
// Payment cards never pass through: they stay in Supabase.

import { supabase } from './supabase'
import type { ChatMessage } from './chatService'
import { putMessages, patchMessages } from './localChat'

interface Signal { kind: 'delivered' | 'read' | 'delete'; ids: string[]; at: string }

/** Parses a signal row's content (exported for tests). */
export function parseSignal(content: string | null | undefined): Signal | null {
  try {
    const v = JSON.parse(content ?? '')
    if (!v || !['delivered', 'read', 'delete'].includes(v.kind) || !Array.isArray(v.ids)) return null
    const ids = v.ids.filter((x: unknown) => typeof x === 'string').slice(0, 500)
    return { kind: v.kind, ids, at: typeof v.at === 'string' ? v.at : new Date().toISOString() }
  } catch { return null }
}

/** Applies one signal (sent by `from`) to my copies on this phone (exported for tests). */
export async function applySignal(userId: string, from: string, sig: Signal): Promise<void> {
  if (sig.kind === 'delete') {
    // Only the person who wrote a message can delete it for everyone.
    await patchMessages(userId, sig.ids, m => (m.sender_id === from
      ? { content: '[deleted]', type: 'text', deleted_at: sig.at }
      : {}))
    return
  }
  // Receipts are for my own messages only.
  await patchMessages(userId, sig.ids, m => {
    if (m.sender_id === from) return {}
    if (sig.kind === 'delivered') return m.delivered_at ? {} : { delivered_at: sig.at }
    return { delivered_at: m.delivered_at ?? sig.at, read_at: m.read_at ?? sig.at, is_read: true }
  })
}

const BATCH = 200
const running = new Map<string, Promise<number>>()
const again = new Set<string>()

/**
 * Takes all my waiting mail: saved here first, then acknowledged (deleted on
 * the server). Returns how many rows were taken. Calls made while one runs
 * are folded into one more pass after it.
 */
export function syncMailbox(userId: string): Promise<number> {
  const busy = running.get(userId)
  if (busy) { again.add(userId); return busy }
  const p = (async () => {
    let total = 0
    for (let round = 0; round < 20; round++) {
      again.delete(userId)
      const { data, error } = await supabase.rpc('chat_peek_mail', { p_limit: BATCH })
      if (error) {
        // Before the migration runs: nothing to do (chat keeps working as before).
        if (!/chat_peek_mail/.test(error.message ?? '')) console.error('[chatMailbox] peek failed:', error.message)
        break
      }
      const rows = (data ?? []) as ChatMessage[]
      if (!rows.length) { if (!again.has(userId)) break; continue }
      const chat = rows.filter(r => r.type !== 'signal')
      // A message reaching this phone counts as delivered here.
      const now = new Date().toISOString()
      await putMessages(userId, chat.map(r => ({ ...r, delivered_at: r.delivered_at ?? now })))
      for (const r of rows.filter(r => r.type === 'signal')) {
        const sig = parseSignal(r.content)
        if (sig) await applySignal(userId, r.sender_id, sig)
      }
      const { error: ackErr } = await supabase.rpc('chat_ack_mail', { p_ids: rows.map(r => r.id) })
      if (ackErr) { console.error('[chatMailbox] ack failed:', ackErr.message); break }
      total += rows.length
      if (rows.length < BATCH && !again.has(userId)) break
    }
    return total
  })().catch(e => { console.error('[chatMailbox] sync failed:', e instanceof Error ? e.message : e); return 0 })
    .finally(() => running.delete(userId))
  running.set(userId, p)
  return p
}

/** Read receipt / delete for everyone: sent to the other person as a signal. */
export async function sendSignal(conversationId: string, kind: 'read' | 'delete', ids: string[]): Promise<boolean> {
  if (!ids.length) return true
  let ok = true
  for (let i = 0; i < ids.length; i += 500) {
    const { error } = await supabase.rpc('chat_signal', { p_conversation: conversationId, p_kind: kind, p_ids: ids.slice(i, i + 500) })
    if (error) { ok = false; console.error('[chatMailbox] signal failed:', error.message) }
  }
  return ok
}
