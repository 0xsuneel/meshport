// Delivery receipts (two grey ticks): while MeshPort is open on any screen,
// messages other people sent to me are marked delivered. Read receipts (blue)
// stay the job of the open conversation (markRead).
import { supabase } from './supabase'
import { subscribeWithRetry } from './chatService'

let myConvIds = new Set<string>()

async function loadMyConversations(userId: string): Promise<string[]> {
  const { data } = await supabase.from('conversations').select('id')
    .or(`participant_a.eq.${userId},participant_b.eq.${userId}`)
  const ids = (data ?? []).map((c: any) => String(c.id))
  myConvIds = new Set(ids)
  return ids
}

async function markDelivered(userId: string, convIds: string[]) {
  if (convIds.length === 0) return
  // Only other people's messages that aren't marked yet.
  for (let i = 0; i < convIds.length; i += 100) {
    await supabase.from('messages').update({ delivered_at: new Date().toISOString() })
      .in('conversation_id', convIds.slice(i, i + 100)).neq('sender_id', userId).is('delivered_at', null)
  }
}

/** Starts delivery receipts for this user. Returns a stop function. */
export function startDeliveryReceipts(userId: string): () => void {
  let stopped = false
  const catchUp = () => {
    if (stopped) return
    loadMyConversations(userId).then(ids => markDelivered(userId, ids)).catch(() => {})
  }
  catchUp()
  const unsubscribe = subscribeWithRetry(supabase, 'chat-delivery-' + userId.slice(0, 12), channel => channel
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, async (payload: any) => {
      const m = payload?.new
      if (!m?.id || m.sender_id === userId || m.delivered_at) return
      const conv = String(m.conversation_id)
      // A conversation I haven't seen yet (someone just started one): refresh.
      if (!myConvIds.has(conv)) await loadMyConversations(userId).catch(() => {})
      if (!myConvIds.has(conv)) return
      await supabase.from('messages').update({ delivered_at: new Date().toISOString() }).eq('id', m.id).is('delivered_at', null)
    }),
    { onReconnect: catchUp },
  )
  // Coming back to the app (phone unlocked, tab refocused): catch up.
  const onVisible = () => { if (document.visibilityState === 'visible') catchUp() }
  document.addEventListener('visibilitychange', onVisible)
  return () => { stopped = true; unsubscribe(); document.removeEventListener('visibilitychange', onVisible) }
}
