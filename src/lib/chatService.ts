/**
 * chatService.ts — Bulletproof chat persistence.
 * No supabase-js for writes. All writes go to /api/send-message (service key)
 * with direct Supabase REST as fallback.
 */
import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js'
import { supabase as _sbClient } from './supabase'

// BUG FIX: this used to hardcode a literal project URL/key
// ('cvvpzfvzweszuuxvaayb.supabase.co') instead of reading the same env vars
// as src/lib/supabase.ts (whose `supabase` client is what every realtime
// channel in ChatPage.tsx subscribes through). If VITE_SUPABASE_URL ever
// points to a different project than this hardcoded one — a redeployed/
// rotated project, a staging vs prod mismatch, anything — every read/write
// here would go to one project while realtime subscribes to another,
// producing exactly "message shows after a refresh but never live": refresh
// re-reads from wherever THIS file points, which always has the data,
// while the realtime socket listens to a project that never received the
// write at all. Now sourced from the same env vars everywhere else uses, so
// they cannot drift apart. The literal values remain only as a last-resort
// fallback so local dev without a fully configured .env doesn't hard-crash.
const SUPA_URL = (import.meta.env.VITE_SUPABASE_URL as string) || 'https://cvvpzfvzweszuuxvaayb.supabase.co'
const ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string) || 'sb_publishable_PA16DyqFzvPLjxUeWqJU-Q_PPinntp2'
if (!import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON_KEY) {
  console.error('[chatService] VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY not set — falling back to a hardcoded project. Chat reads/writes may be pointed at a different Supabase project than realtime subscribes to.')
}

// ── Auth headers for raw REST calls ─────────────────────────────────────────
// This file intentionally bypasses supabase-js for most calls (see file
// header), using the bare ANON_KEY as the bearer token. That was invisible
// under wide-open RLS (using (true) doesn't care who's asking) but breaks
// silently once RLS actually scopes rows by auth.uid() — a bare anon-key
// request carries no session, so auth.uid() is null and every ownership
// check fails, with PostgREST just returning 0 matching rows (no error).
// Using the real session's access_token here fixes that while keeping the
// same bare-anon-key fallback for the (rare) case there's no session yet.
export async function authHeaders(): Promise<Record<string, string>> {
  try {
    const { data: { session } } = await _sbClient.auth.getSession()
    const token = session?.access_token || ANON_KEY
    return { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` }
  } catch {
    return { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}` }
  }
}

/**
 * Subscribe to a Supabase Realtime channel with automatic reconnect.
 *
 * Plain `.subscribe()` has no built-in recovery: if the socket drops (tab
 * backgrounded, a brief network blip, an auth token refresh invalidating the
 * channel) it just goes silent — CHANNEL_ERROR / TIMED_OUT / CLOSED never
 * retry on their own. Without this, "instant live messages" quietly
 * degrades into "works until something hiccups, then needs a manual
 * refresh" — which is indistinguishable from realtime being broken
 * entirely from the user's point of view. That's the bug this fixes.
 *
 * `configure` receives a fresh channel on each (re)connect attempt — attach
 * .on(...) handlers to it and return it. This function handles calling
 * .subscribe(), retrying on drop, resyncing on tab-focus/network-regain,
 * and cleanup.
 */
export function subscribeWithRetry(
  client: SupabaseClient,
  channelNameBase: string,
  configure: (channel: RealtimeChannel) => RealtimeChannel,
  opts?: { retryDelayMs?: number; onReconnect?: () => void },
): () => void {
  const baseRetryDelayMs = opts?.retryDelayMs ?? 2000
  // Bug fix: this used to retry at a flat 2s forever, no backoff, no cap.
  // On a persistently bad connection (seen in practice well under 10 KB/s),
  // the socket can fail to establish over and over — a flat interval means
  // that's a genuinely unbounded retry loop, hundreds of attempts within a
  // few minutes, each one creating a fresh channel and tearing down the
  // last. That volume of churn is the most likely trigger for a real
  // Supabase-js RangeError (stack overflow deep inside its own channel
  // trigger/cleanup logic) observed directly in production under exactly
  // these conditions — not something reachable from a normal drop-and-
  // recover connection, only from sustained hammering like this. Backing
  // off exponentially (capped, with jitter so many tabs/subscriptions
  // don't all retry in lockstep) cuts the attempt volume dramatically
  // under a bad connection while staying just as fast to recover from a
  // single brief drop — the very next attempt is still at the original
  // 2s baseline; only REPEATED failures slow the pace down.
  const MAX_RETRY_DELAY_MS = 30_000
  let currentRetryDelayMs = baseRetryDelayMs
  let cancelled = false
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let channel: RealtimeChannel | null = null

  const connect = () => {
    if (cancelled) return
    // A resync (below) or a fresh manual connect supersedes any pending
    // auto-retry — without this, a retry scheduled right as the tab was
    // backgrounded (backgrounding very commonly drops the socket, which
    // schedules exactly this) would still fire later and create a second,
    // duplicate connection on top of whatever connect() is doing right now.
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    attempt += 1
    // Unique-per-attempt channel name — supabase-js can reject a
    // re-subscribe on a channel name still mid-teardown as "already
    // subscribed"; a fresh name per attempt sidesteps that entirely.
    const myAttempt = attempt
    // Re-entrancy guard for THIS attempt's terminal status.
    //
    // client.removeChannel() synchronously calls channel.unsubscribe(), which
    // inside supabase-js runs leave() -> trigger() and re-invokes THIS status
    // callback with 'CLOSED'. Before this flag existed the terminal branch
    // below therefore called removeChannel() again on the same dying channel,
    // which closed again, which re-entered again — unbounded SYNCHRONOUS
    // recursion ending in "RangeError: Maximum call stack size exceeded" deep
    // in supabase-js (Array.filter -> trigger -> leave -> unsubscribe).
    //
    // The giveaway in the logs was hundreds of drop warnings all quoting the
    // SAME delay (e.g. 25504ms): the line that advances the backoff sits after
    // removeChannel(), so it never ran until the recursion unwound and every
    // nested frame read the same stale value.
    //
    // `cancelled` did not cover this: it is only set by the unsubscribe
    // cleanup. A resync (visibilitychange/online — i.e. simply navigating to a
    // page) or a real socket drop both reach the branch with cancelled=false
    // and myAttempt===attempt, so neither existing guard applied.
    let settled = false
    channel = configure(client.channel(`${channelNameBase}-${attempt}`))
    channel.subscribe((status) => {
      if (cancelled) return
      // A newer connect() has already superseded this one (e.g. a second
      // resync fired before this attempt finished subscribing) — this
      // callback is for a channel that's no longer the current one, so
      // don't act on it. Without this, a stale callback could remove the
      // channel a NEWER attempt is actively using, or schedule a redundant
      // retry on top of one already in progress.
      if (myAttempt !== attempt) return
      if (status === 'SUBSCRIBED') {
        // A real, successful connection — the backoff earned by however
        // many failures came before this no longer applies. Reset it so
        // the NEXT drop (a fresh, likely-unrelated issue) starts fast
        // again at the 2s baseline instead of inheriting a slow pace from
        // trouble that's already resolved.
        currentRetryDelayMs = baseRetryDelayMs
        if (attempt > 1) {
          // Reconnected after a drop — the socket only sees INSERTs from
          // this point forward, so anything that happened during the gap
          // (a message sent while we were disconnected) needs a manual
          // re-fetch to avoid silently missing it.
          opts?.onReconnect?.()
        }
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        // One terminal transition per attempt. A nested 'CLOSED' produced by
        // our own teardown below lands here and returns immediately.
        if (settled) return
        settled = true

        const delay = currentRetryDelayMs
        console.warn(`[Realtime] ${channelNameBase} dropped (${status}) — reconnecting in ${Math.round(delay)}ms`)

        // Detach the reference BEFORE removing, so no other path (onResync, the
        // unsubscribe cleanup) can remove this same object a second time.
        const dying = channel
        channel = null

        // Remove OUTSIDE this callback. removeChannel() unsubscribes
        // synchronously and would otherwise re-enter this very function while
        // it is still on the stack; a microtask lets the current frame finish
        // first, so the `settled` guard above is the only thing the nested
        // close has to trip over rather than the recursion depth.
        if (dying) {
          queueMicrotask(() => {
            try { client.removeChannel(dying) } catch { /* already gone */ }
          })
        }

        retryTimer = setTimeout(connect, delay)
        // ±20% jitter applied to NEXT attempt's delay, not this one already
        // scheduled — keeps repeated failures from many tabs/subscriptions
        // syncing up and retrying in lockstep.
        currentRetryDelayMs = Math.min(currentRetryDelayMs * 2, MAX_RETRY_DELAY_MS) * (0.8 + Math.random() * 0.4)
      }
    })
  }
  connect()

  // Resync on tab focus / network regain — catches gaps the socket-level
  // reconnect above can still miss (e.g. a laptop asleep for a long stretch,
  // where the OS may not even surface a clean CLOSE event to the socket).
  // Debounced and reentrancy-guarded: some mobile browsers fire
  // visibilitychange more than once (sometimes paired with an 'online'
  // event too) on a single resume from background — without this, each of
  // those fired its own overlapping teardown-and-reconnect, which for the
  // 2-3 realtime subscriptions active at once while a chat is open could
  // cascade into several simultaneous WebSocket rebuilds and visibly hang
  // the page right when returning from another app.
  let resyncScheduled = false
  const onResync = () => {
    if (cancelled) return
    if (document.visibilityState !== 'visible') return
    if (resyncScheduled) return
    resyncScheduled = true
    setTimeout(() => {
      resyncScheduled = false
      if (cancelled) return
      // Detach before removing, then let connect() build a fresh channel. The
      // removal still triggers a 'CLOSED' on the old channel's callback, but
      // that attempt's `settled` guard absorbs it — and because `channel` is
      // already null here, nothing can double-remove this object.
      const dying = channel
      channel = null
      if (dying) {
        try { client.removeChannel(dying) } catch { /* already gone */ }
      }
      connect()
    }, 150)
  }
  document.addEventListener('visibilitychange', onResync)
  window.addEventListener('online', onResync)

  return () => {
    cancelled = true
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    // Same detach-then-remove discipline. `cancelled` already makes the status
    // callback a no-op, so the 'CLOSED' this triggers is inert — but nulling
    // first guarantees no path can remove the same channel twice, which is what
    // makes leaving and re-entering a page reliably produce exactly one
    // subscription.
    const dying = channel
    channel = null
    if (dying) {
      try { client.removeChannel(dying) } catch { /* already gone */ }
    }
    document.removeEventListener('visibilitychange', onResync)
    window.removeEventListener('online', onResync)
  }
}

export interface ChatMessage {
  id: string
  conversation_id: string
  sender_id: string
  content: string
  type: string
  payment_amount: number | null
  payment_tx_hash: string | null
  token_symbol: string | null
  is_read: boolean
  created_at: string
}

export interface SendParams {
  conversationId: string
  senderId: string
  content: string
  type?: string
  paymentAmount?: number | null
  paymentTxHash?: string | null
  tokenSymbol?: string
  senderWalletAddress?: string
  recipientWalletAddress?: string
  toUsername?: string
}

// ── Load messages from Supabase REST (anon key — SELECT works fine) ───────────
export async function loadMessages(conversationId: string): Promise<ChatMessage[]> {
  try {
    // Fetch newest 100 first (DESC), then reverse for display order
    const r = await fetch(
      `${SUPA_URL}/rest/v1/messages?conversation_id=eq.${encodeURIComponent(conversationId)}&order=created_at.desc&limit=1000&select=*`,
      { headers: await authHeaders() }
    )
    if (!r.ok) {
      console.error('[chatService] loadMessages HTTP', r.status, await r.text().catch(() => ''))
      return []
    }
    const data = await r.json()
    const rows = Array.isArray(data) ? data : []
    // Reverse so oldest messages are first (correct display order)
    return [...rows].reverse()
  } catch (e: any) {
    console.error('[chatService] loadMessages error:', e?.message)
    return []
  }
}

// ── Get or create conversation ────────────────────────────────────────────────
export async function ensureConversation(myId: string, otherId: string): Promise<string | null> {
  // Check existing
  try {
    const r = await fetch(
      `${SUPA_URL}/rest/v1/conversations?or=(and(participant_a.eq.${myId},participant_b.eq.${otherId}),and(participant_a.eq.${otherId},participant_b.eq.${myId}))&select=id&limit=1`,
      { headers: await authHeaders() }
    )
    if (r.ok) {
      const data = await r.json()
      if (Array.isArray(data) && data[0]?.id) return data[0].id
    }
  } catch {}

  // Create via server API
  try {
    const r = await fetch('/api/chat?action=create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantA: myId, participantB: otherId }),
    })
    const json = await r.json().catch(() => ({}))
    if (r.ok && json?.id) return json.id
    console.error('[chatService] create-conversation failed:', r.status, json)
  } catch (e: any) {
    console.error('[chatService] create-conversation error:', e?.message)
  }

  // Fallback: direct anon INSERT (works with RLS policy)
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/conversations`, {
      method: 'POST',
      headers: {
        ...(await authHeaders()),
        'Content-Type': 'application/json', 'Prefer': 'return=representation',
      },
      body: JSON.stringify({ participant_a: myId, participant_b: otherId }),
    })
    if (r.ok) {
      const d = await r.json()
      const row = Array.isArray(d) ? d[0] : d
      if (row?.id) return row.id
    }
  } catch {}

  return null
}

// ── Persist message — 3 paths ─────────────────────────────────────────────────
export async function persistMessage(p: SendParams): Promise<ChatMessage | null> {
  // PATH 1: Vercel /api/send-message with service role key
  try {
    const r = await fetch('/api/chat?action=send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId:        p.conversationId,
        senderId:              p.senderId,
        content:               p.content,
        type:                  p.type ?? 'text',
        paymentAmount:         p.paymentAmount         ?? null,
        paymentTxHash:         p.paymentTxHash         ?? null,
        tokenSymbol:           p.tokenSymbol           ?? 'USDC',
        senderWalletAddress:   p.senderWalletAddress   ?? null,
        recipientWalletAddress:p.recipientWalletAddress?? null,
        toUsername:            p.toUsername             ?? null,
      }),
    })
    const responseText = await r.text()
    let json: any
    try { json = JSON.parse(responseText) } catch { json = {} }

    if (r.ok && json?.data?.id) {
      return json.data as ChatMessage
    }
  } catch (e: any) {
  }

  // PATH 2: Direct REST with anon key (needs RLS INSERT policy for anon role)
  try {
    // Minimal row — no token_symbol in case column doesn't exist yet
    const minRow: Record<string, any> = {
      conversation_id: p.conversationId,
      sender_id:       p.senderId,
      content:         p.content,
      type:            p.type ?? 'text',
      is_read:         false,
    }
    if (p.paymentAmount != null)  minRow.payment_amount  = p.paymentAmount
    if (p.paymentTxHash)          minRow.payment_tx_hash = p.paymentTxHash

    const r = await fetch(`${SUPA_URL}/rest/v1/messages`, {
      method: 'POST',
      headers: {
        ...(await authHeaders()),
        'Content-Type':  'application/json',
        'Prefer':        'return=representation',
      },
      body: JSON.stringify(minRow),
    })
    const responseText = await r.text()
    if (r.ok) {
      let data: any
      try { data = JSON.parse(responseText) } catch { data = null }
      const msg = Array.isArray(data) ? data[0] : data
      if (msg?.id) {
        return { ...msg, token_symbol: p.tokenSymbol ?? 'USDC' } as ChatMessage
      }
    }
  } catch (e: any) {
  }

  console.error('[chatService] ✗ ALL persist paths failed for conv:', p.conversationId)
  return null
}

// ── Touch conversation last_message ───────────────────────────────────────────
export async function touchConversation(
  conversationId: string,
  lastMsg: string,
  senderId?: string,
  messageType?: string,
) {
  // PATH 1: privileged server endpoint (service-role key, bypasses RLS —
  // same reliable pattern as persistMessage's /api/send-message call).
  try {
    const r = await fetch('/api/chat?action=touch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        lastMessage: lastMsg,
        senderId:    senderId    ?? null,
        messageType: messageType ?? null,
      }),
    })
    if (r.ok) return
    console.error('[chatService] touchConversation API failed:', r.status)
  } catch (e: any) {
    console.error('[chatService] touchConversation API error:', e?.message)
  }

  // PATH 2: direct REST fallback — only succeeds if RLS allows anon updates,
  // but kept as a best-effort safety net if the API route itself is down.
  try {
    const patch: Record<string, string> = {
      last_message: lastMsg,
      last_message_at: new Date().toISOString(),
    }
    if (senderId)    patch.last_message_sender = senderId
    if (messageType) patch.last_message_type   = messageType
    const r = await fetch(`${SUPA_URL}/rest/v1/conversations?id=eq.${conversationId}`, {
      method: 'PATCH',
      headers: {
        ...(await authHeaders()),
        'Content-Type': 'application/json', 'Prefer': 'return=minimal',
      },
      body: JSON.stringify(patch),
    })
    if (!r.ok) console.error('[chatService] touchConversation fallback PATCH failed:', r.status)
  } catch (e: any) {
    console.error('[chatService] touchConversation fallback error:', e?.message)
  }
}

// ── Mark messages read ────────────────────────────────────────────────────────
export async function markRead(conversationId: string, myId: string) {
  try {
    // BUG FIX (2026-09-03): a self-conversation (participant_a ===
    // participant_b === myId — you paying/messaging your own username) has
    // EVERY message's sender_id equal to myId, including the
    // payment_received leg (its sender_id is deliberately rewritten to the
    // recipient's id elsewhere — see fetchConversations's trueSender
    // comment in supabase.ts — which in a self-chat is also myId). So
    // `sender_id=neq.${myId}` matches ZERO rows here for a self-chat, no
    // matter how many times it's opened — those messages can NEVER be
    // marked read, and the unread badge only ever grows, one row per
    // self-payment, forever. That's the real cause behind a self-chat
    // showing a large, permanently-climbing unread count (e.g. "29") even
    // though there's no one else who could have left something unread.
    // Detected with a cheap, single-row lookup rather than requiring every
    // caller to know/pass this — self-chats are rare enough that the extra
    // request is negligible, and this keeps the fix contained to exactly
    // where the bug lives instead of touching every call site.
    let isSelfChat = false
    try {
      const res = await fetch(
        `${SUPA_URL}/rest/v1/conversations?id=eq.${conversationId}&select=participant_a,participant_b`,
        { headers: await authHeaders() },
      )
      const rows = await res.json().catch(() => [])
      const conv = Array.isArray(rows) ? rows[0] : null
      isSelfChat = !!conv && conv.participant_a === conv.participant_b
    } catch { /* fall through — worst case, self-chat messages stay unread this one call */ }

    const senderFilter = isSelfChat ? '' : `&sender_id=neq.${myId}`
    await fetch(
      `${SUPA_URL}/rest/v1/messages?conversation_id=eq.${conversationId}${senderFilter}&is_read=eq.false`,
      {
        method: 'PATCH',
        headers: {
          ...(await authHeaders()),
          'Content-Type': 'application/json', 'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ is_read: true }),
      }
    )
  } catch {}
}

// ── Realtime subscription via native WebSocket ────────────────────────────────
export function subscribeToMessages(
  conversationId: string,
  onMessage: (msg: ChatMessage) => void,
): () => void {
  const WS_URL = `${SUPA_URL.replace('https://', 'wss://')}/realtime/v1/websocket?apikey=${ANON_KEY}&vsn=1.0.0`
  let ws: WebSocket | null = null
  let hb: ReturnType<typeof setInterval> | null = null
  let closed = false

  const connect = () => {
    if (closed) return
    try {
      ws = new WebSocket(WS_URL)
      ws.onopen = () => {
        if (closed) { ws?.close(); return }
        ws!.send(JSON.stringify({
          topic: `realtime:public:messages:conversation_id=eq.${conversationId}`,
          event: 'phx_join', payload: {}, ref: '1',
        }))
        hb = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: null }))
        }, 25_000)
      }
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.event === 'INSERT' && msg.payload?.record) {
            onMessage(msg.payload.record as ChatMessage)
          }
        } catch {}
      }
      ws.onerror = () => {}
      ws.onclose = () => {
        if (hb) clearInterval(hb)
        if (!closed) setTimeout(connect, 3000)
      }
    } catch {}
  }

  connect()
  return () => { closed = true; if (hb) clearInterval(hb); ws?.close() }
}
