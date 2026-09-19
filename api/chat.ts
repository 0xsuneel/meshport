import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sendPushToUser } from './_lib/push'

/**
 * MERGED FUNCTIONS (to stay under Vercel's 12-function limit):
 * - action=create  ← formerly api/create-conversation.ts
 * - action=send    ← formerly api/send-message.ts
 * - action=touch   ← formerly api/touch-conversation.ts
 *
 * All three are called as POST /api/chat?action=<create|send|touch>
 */

const SUPABASE_URL = (
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  'https://cvvpzfvzweszuuxvaayb.supabase.co'
).trim()

const SERVICE_KEY = (
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  ''
).trim()

async function supaFetch(path: string, method: string, body?: object, preferOverride?: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      'apikey':        SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        preferOverride || (method === 'POST' ? 'return=representation' : 'return=minimal'),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { json = text }
  return { ok: res.ok, status: res.status, data: json }
}

async function insertActivity(row: object) {
  return fetch(`${SUPABASE_URL}/rest/v1/activity`, {
    method: 'POST',
    headers: {
      'apikey':        SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal,resolution=ignore-duplicates',
    },
    body: JSON.stringify(row),
  })
}

async function insertMessage(row: any) {
  // Payment cards (payment_sent / payment_received) carry a payment_tx_hash —
  // upsert on (payment_tx_hash, type) so a client-side retry of this same
  // request (e.g. after a timed-out-but-actually-succeeded first attempt)
  // returns the existing row instead of inserting a duplicate card.
  const path = row.payment_tx_hash
    ? '/messages?on_conflict=payment_tx_hash,type'
    : '/messages'
  return supaFetch(path, 'POST', row, row.payment_tx_hash ? 'resolution=merge-duplicates,return=representation' : undefined)
}

// ── action=create — get-or-create a conversation between two users ─────────
async function handleCreateConversation(req: VercelRequest, res: VercelResponse) {
  if (!SERVICE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not set in Vercel env vars' })
  }

  const { participantA, participantB } = req.body || {}
  if (!participantA || !participantB) {
    return res.status(400).json({ error: 'Missing participantA or participantB' })
  }

  // Check if already exists
  const existRes = await supaFetch(
    `/conversations?or=(and(participant_a.eq.${participantA},participant_b.eq.${participantB}),and(participant_a.eq.${participantB},participant_b.eq.${participantA}))&select=id&limit=1`,
    'GET'
  )
  if (existRes.ok && Array.isArray(existRes.data) && existRes.data[0]?.id) {
    return res.status(200).json({ id: existRes.data[0].id, error: null })
  }

  // Create new
  const createRes = await supaFetch('/conversations', 'POST', {
    participant_a: participantA,
    participant_b: participantB,
  })

  if (!createRes.ok) {
    // Race condition check
    const retry = await supaFetch(
      `/conversations?or=(and(participant_a.eq.${participantA},participant_b.eq.${participantB}),and(participant_a.eq.${participantB},participant_b.eq.${participantA}))&select=id&limit=1`,
      'GET'
    )
    if (retry.ok && Array.isArray(retry.data) && retry.data[0]?.id) {
      return res.status(200).json({ id: retry.data[0].id, error: null })
    }
    console.error('[chat/create] failed:', createRes.status, createRes.data)
    return res.status(500).json({ error: 'Failed to create conversation', detail: createRes.data })
  }

  const row = Array.isArray(createRes.data) ? createRes.data[0] : createRes.data
  return res.status(200).json({ id: row?.id || '', error: null })
}

// ── action=send — persist a chat message (including payment cards) ─────────
async function handleSendMessage(req: VercelRequest, res: VercelResponse) {
  if (!SERVICE_KEY) {
    console.error('[chat/send] SUPABASE_SERVICE_KEY not set')
    return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_KEY not set' })
  }

  const {
    conversationId, senderId, content,
    type = 'text', paymentAmount, paymentTxHash, tokenSymbol = 'USDC',
    senderWalletAddress, recipientWalletAddress, toUsername,
  } = req.body || {}

  if (!conversationId || !senderId || !content) {
    return res.status(400).json({ error: 'Missing: conversationId, senderId, content' })
  }

  console.log(`[chat/send] type=${type} conv=${conversationId} from=${String(senderId).slice(0, 8)}`)

  // ── 1. Insert sender's message ──────────────────────────────────────────────
  const senderRow = {
    conversation_id: conversationId,
    sender_id:       senderId,
    content,
    type,
    payment_amount:  paymentAmount  || null,
    payment_tx_hash: paymentTxHash  || null,
    token_symbol:    tokenSymbol,
    is_read:         false,
  }

  const insertRes = await insertMessage(senderRow)
  if (!insertRes.ok) {
    console.error('[chat/send] sender insert failed:', insertRes.status, JSON.stringify(insertRes.data).slice(0, 300))
    return res.status(500).json({ error: 'DB insert failed', status: insertRes.status, detail: insertRes.data })
  }

  const msgRow = Array.isArray(insertRes.data) ? insertRes.data[0] : insertRes.data
  console.log('[chat/send] ✓ sender msg id:', msgRow?.id)

  // ── 2. Update conversation last_message ────────────────────────────────────
  supaFetch(
    `/conversations?id=eq.${conversationId}`,
    'PATCH',
    { last_message: content, last_message_at: new Date().toISOString(),
      last_message_sender: senderId, last_message_type: type }
  ).catch(() => {})

  // ── 3. If payment_sent: insert payment_received for the recipient ──────────
  if (type === 'payment_sent' && paymentAmount) {
    // Look up the conversation to find the recipient's user ID
    const convRes = await supaFetch(
      `/conversations?id=eq.${conversationId}&select=participant_a,participant_b`,
      'GET'
    )
    if (convRes.ok && Array.isArray(convRes.data) && convRes.data[0]) {
      const conv = convRes.data[0]
      const recipientId = conv.participant_a === senderId ? conv.participant_b : conv.participant_a

      // Resolve wallets if not passed
      let senderWallet = senderWalletAddress || null
      let recipientWallet = recipientWalletAddress || null
      let senderUsername: string | null = null
      if (!senderWallet || !recipientWallet) {
        const userIds = [senderId, recipientId].filter(Boolean)
        const usersRes = await supaFetch(`/users?id=in.(${userIds.join(',')})&select=id,wallet_address,username`, 'GET')
        if (usersRes.ok && Array.isArray(usersRes.data)) {
          for (const u of usersRes.data) {
            if (u.id === senderId && !senderWallet) senderWallet = u.wallet_address
            if (u.id === recipientId && !recipientWallet) recipientWallet = u.wallet_address
            if (u.id === senderId) senderUsername = u.username
          }
        }
      }

      // Record send activity for sender (idempotent via tx_hash unique key)
      if (senderWallet && paymentTxHash) {
        insertActivity({
          wallet_address:        senderWallet.toLowerCase(),
          user_id:               senderId,
          tx_hash:               `send_${paymentTxHash.toLowerCase()}`,
          activity_type:         'send',
          amount:                paymentAmount,
          usd_value:             paymentAmount,
          token_symbol:          tokenSymbol,
          counterparty_address:  recipientWallet?.toLowerCase() ?? null,
          status:                'completed',
          metadata:              { toUsername: toUsername || null, source: 'chat-api' },
        }).catch(() => {})
      }

      // Record receive activity for recipient (idempotent via tx_hash unique key)
      if (recipientWallet && paymentTxHash) {
        insertActivity({
          wallet_address:        recipientWallet.toLowerCase(),
          user_id:               recipientId,
          tx_hash:               `recv_${paymentTxHash.toLowerCase()}`,
          activity_type:         'receive',
          amount:                paymentAmount,
          usd_value:             paymentAmount,
          token_symbol:          tokenSymbol,
          counterparty_address:  senderWallet?.toLowerCase() ?? null,
          status:                'completed',
          metadata:              { fromUsername: null, source: 'chat-api' },
        }).catch(() => {})
      }

      // Insert payment_received message for the recipient's chat view
      const recipientRow = {
        conversation_id: conversationId, // same conversation
        sender_id:       recipientId,    // recipient appears as sender for their view
        content:         content,        // same content string
        type:            'payment_received',
        payment_amount:  paymentAmount,
        payment_tx_hash: paymentTxHash  || null,
        token_symbol:    tokenSymbol,
        is_read:         true,           // pre-read: only unread for the actual recipient via their own query
      }

      const recvRes = await insertMessage(recipientRow)
      if (recvRes.ok) {
        const recvRow = Array.isArray(recvRes.data) ? recvRes.data[0] : recvRes.data
        console.log('[chat/send] ✓ recipient payment_received id:', recvRow?.id)

        // Push notification — works for any token (USDC, EURC, cirBTC, ...)
        // since tokenSymbol is generic.
        const fromLabel = senderUsername ? `${senderUsername}.arc` : 'someone'
        sendPushToUser(recipientId, {
          title: 'Received',
          body: `+${paymentAmount} ${tokenSymbol} from ${fromLabel}`,
          url: `/chat/${conversationId}`,
          tag: `payment-${paymentTxHash || recvRow?.id}`,
        }).catch(() => {})
      } else {
        console.warn('[chat/send] recipient insert failed:', recvRes.status, JSON.stringify(recvRes.data).slice(0, 200))
      }
    }
  }

  return res.status(200).json({ data: msgRow, error: null })
}

// ── action=touch — update a conversation's last_message preview ────────────
async function handleTouchConversation(req: VercelRequest, res: VercelResponse) {
  if (!SERVICE_KEY) {
    console.error('[chat/touch] SUPABASE_SERVICE_KEY not set')
    return res.status(500).json({ error: 'Server misconfigured: SUPABASE_SERVICE_KEY not set' })
  }

  const { conversationId, lastMessage, senderId, messageType } = req.body || {}
  if (!conversationId || !lastMessage) {
    return res.status(400).json({ error: 'Missing: conversationId, lastMessage' })
  }

  const patch: Record<string, string> = {
    last_message: lastMessage,
    last_message_at: new Date().toISOString(),
  }
  if (senderId)    patch.last_message_sender = senderId
  if (messageType) patch.last_message_type   = messageType

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/conversations?id=eq.${conversationId}`, {
      method: 'PATCH',
      headers: {
        'apikey':        SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify(patch),
    })
    if (!r.ok) {
      const detail = await r.text().catch(() => '')
      console.error('[chat/touch] PATCH failed:', r.status, detail.slice(0, 300))
      return res.status(500).json({ error: 'DB update failed', status: r.status })
    }
    return res.status(200).json({ ok: true })
  } catch (e: any) {
    console.error('[chat/touch] error:', e?.message)
    return res.status(500).json({ error: e?.message || 'Unknown error' })
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Content-Type', 'application/json')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' })

  const action = (req.query.action as string) || ''

  if (action === 'create') return handleCreateConversation(req, res)
  if (action === 'send')   return handleSendMessage(req, res)
  if (action === 'touch')  return handleTouchConversation(req, res)

  return res.status(400).json({ error: 'Missing or unknown action. Use ?action=create|send|touch' })
}
