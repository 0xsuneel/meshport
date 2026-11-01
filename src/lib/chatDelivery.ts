// Device-only chat delivery: while MeshPort is open on any screen, chat
// messages waiting for me are saved on this phone and removed from the
// server (lib/chatMailbox.ts). Taking them is what sends the sender their
// delivered receipt (two grey ticks). Read receipts (blue) stay the job of
// the open conversation (markRead).
import { supabase } from './supabase'
import { subscribeWithRetry } from './chatService'
import { syncMailbox } from './chatMailbox'

/** Starts mail pickup for this user. Returns a stop function. */
export function startDeliveryReceipts(userId: string): () => void {
  let stopped = false
  const catchUp = () => { if (!stopped) void syncMailbox(userId) }
  catchUp()
  const unsubscribe = subscribeWithRetry(supabase, 'chat-delivery-' + userId.slice(0, 12), channel => channel
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload: any) => {
      const m = payload?.new
      if (!m?.id || m.type === 'payment_sent' || m.type === 'payment_received') return
      // Mine to take (from someone else, or a signal about my messages) -
      // the server decides which rows are mine.
      catchUp()
    }),
    { onReconnect: catchUp },
  )
  // Coming back to the app (phone unlocked, tab refocused) or back online: catch up.
  const onVisible = () => { if (document.visibilityState === 'visible') catchUp() }
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('online', catchUp)
  return () => {
    stopped = true
    unsubscribe()
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('online', catchUp)
  }
}
