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

// H-2 FIX: hardcoded Supabase project URL removed — a missing env var now
// fails loudly at request time instead of silently hitting production DB.
const SUPABASE_URL = (
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  ''
).trim()
if (!SUPABASE_URL) console.error('[chat] SUPABASE_URL is not set — all chat/conversation requests will fail')

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
  // ignore-duplicates, NOT merge: a tx hash is public, so merging let anyone
  // overwrite another user's payment card by re-sending its hash. A retry of
  // the same card returns nothing here and is then read back below.
  const r = await supaFetch(path, 'POST', row, row.payment_tx_hash ? 'resolution=ignore-duplicates,return=representation' : undefined)
  if (r.ok && row.payment_tx_hash && (!Array.isArray(r.data) || r.data.length === 0)) {
    const existing = await supaFetch(
      `/messages?payment_tx_hash=eq.${encodeURIComponent(row.payment_tx_hash)}&type=eq.${row.type}&conversation_id=eq.${row.conversation_id}&sender_id=eq.${row.sender_id}&select=*&limit=1`, 'GET')
    const hit = existing.ok && Array.isArray(existing.data) ? existing.data[0] : null
    return hit ? { ok: true, status: 200, data: [hit] } : { ok: false, status: 409, data: 'duplicate' }
  }
  return r
}

// ── On-chain proof for payment cards ────────────────────────────────────────
// A payment card, its activity rows and the "Received" push are only created
// for a real, successful Arc transaction from the sender's own wallet that
// paid at least the stated amount to the other participant. Without this a
// participant could post "+1,000,000 USDC" cards and pushes for free.
// M-2 FIX: expand the Arc RPC fallback list to include all four official Arc
// Testnet providers (matching api/arc-rpc.js). The previous single legacy
// endpoint was a single point of failure — a slow or rate-limited node
// rejected valid payment-card verifications with 409 instead of retrying.
// Endpoints read from env first so the authenticated/private URL is preferred
// without ever being hard-coded into source.
const ARC_RPCS = [
  (process.env.ARC_RPC_URL || '').trim(),
  'https://rpc.testnet.arc.io',           // arc-studio-allow-onchain-literal  Circle primary (official docs.arc.io endpoint)
  'https://rpc.blockdaemon.testnet.arc.io', // arc-studio-allow-onchain-literal
  'https://rpc.drpc.testnet.arc.io',      // arc-studio-allow-onchain-literal
  'https://rpc.quicknode.testnet.arc.io', // arc-studio-allow-onchain-literal
  'https://rpc.testnet.arc.network',      // arc-studio-allow-onchain-literal  legacy — last-resort fallback
].filter(Boolean)
async function arcRpc(body: object): Promise<any> {
  let lastErr: unknown
  for (const url of ARC_RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
      if (r.ok) return await r.json()
      lastErr = new Error(`HTTP ${r.status}`)
    } catch (e) { lastErr = e }
  }
  throw lastErr
}
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const PAY_TOKENS: Record<string, { contract: string; decimals: number }> = {
  USDC:   { contract: '0x3600000000000000000000000000000000000000', decimals: 6 },
  EURC:   { contract: '0x89b50855aa3be2f677cd6303cec089b5f319d72a', decimals: 6 },
  cirBTC: { contract: '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf', decimals: 8 },
}
const pad32 = (a: string) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0')
// B-1 FIX: the previous toUnits used Number.toFixed() which produces
// floating-point precision artifacts (e.g. (0.1).toFixed(18) is
// '0.100000000000000005551...') — amounts like 0.1 USDC failed the
// >= comparison even when the correct amount was sent. Multiply to integer
// using BigInt arithmetic via a scaled integer to avoid all FP rounding.
function toUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount < 0) return 0n
  // Scale: split at the decimal point, pad or truncate the fractional part
  // to exactly `decimals` digits, then parse as a pure integer — no FP math.
  const str = amount.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: decimals })
  const [intPart, fracPart = ''] = str.split('.')
  const frac = fracPart.padEnd(decimals, '0').slice(0, decimals)
  return BigInt(intPart + frac)
}

async function verifyPayment(txHash: string, from: string, to: string, token: string, amount: number): Promise<'ok' | 'pending' | 'invalid'> {
  const t = PAY_TOKENS[token]
  if (!t) return 'invalid'
  let tx: any = null, rc: any = null
  for (let i = 0; i < 6 && !rc; i++) {
    try {
      const [a, b] = await Promise.all([
        arcRpc({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [txHash] }),
        arcRpc({ jsonrpc: '2.0', id: 2, method: 'eth_getTransactionReceipt', params: [txHash] }),
      ])
      tx = a?.result ?? null; rc = b?.result ?? null
    } catch { /* retry */ }
    if (!rc) await new Promise(r => setTimeout(r, 500))
  }
  if (!rc || !tx) return 'pending'
  if (rc.status !== '0x1') return 'invalid'
  if (String(tx.from || '').toLowerCase() !== from.toLowerCase()) return 'invalid'
  // Native USDC (Arc gas token, 18 decimals): plain value transfer.
  if (token === 'USDC' && String(tx.to || '').toLowerCase() === to.toLowerCase()) {
    if (BigInt(tx.value || '0x0') >= toUnits(amount, 18)) return 'ok'
  }
  // ERC-20 Transfer(from → to) on the token's own contract.
  const want = toUnits(amount, t.decimals)
  for (const log of rc.logs || []) {
    if (String(log.address || '').toLowerCase() !== t.contract) continue
    const tp = log.topics || []
    if (tp[0] !== TRANSFER_TOPIC || tp[1]?.toLowerCase() !== pad32(from) || tp[2]?.toLowerCase() !== pad32(to)) continue
    if (BigInt(log.data || '0x0') >= want) return 'ok'
  }
  return 'invalid'
}

// ── Who is calling ──────────────────────────────────────────────────────────
// This API writes with the service key, so it must check the caller itself:
// the request carries the caller's Supabase session (Authorization: Bearer),
// and a user id is only accepted when that account is linked to exactly this
// session (users.auth_uid — linked with a wallet signature, see the
// bind-session function). Without this, anyone could post messages or fake
// payment cards as anyone.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function sessionUid(req: VercelRequest): Promise<string | null> {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token || token === SERVICE_KEY) return null
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } })
    if (!r.ok) return null
    const u = await r.json().catch(() => null)
    return typeof u?.id === 'string' ? u.id : null
  } catch { return null }
}

/** True when `userId` is the account linked to the caller's session. */
async function callerIs(req: VercelRequest, userId: unknown): Promise<boolean> {
  if (typeof userId !== 'string' || !UUID.test(userId)) return false
  const uid = await sessionUid(req)
  if (!uid) return false
  const r = await supaFetch(`/users?id=eq.${userId}&auth_uid=eq.${uid}&select=id`, 'GET')
  return r.ok && Array.isArray(r.data) && r.data.length === 1
}

async function isParticipant(conversationId: unknown, userId: string): Promise<{ ok: boolean; conv?: any }> {
  if (typeof conversationId !== 'string' || !UUID.test(conversationId)) return { ok: false }
  const r = await supaFetch(`/conversations?id=eq.${conversationId}&select=participant_a,participant_b`, 'GET')
  const conv = r.ok && Array.isArray(r.data) ? r.data[0] : null
  return { ok: !!conv && (conv.participant_a === userId || conv.participant_b === userId), conv }
}

const NOT_LINKED = { error: 'Not signed in to this account', code: 'not_linked' }

// ── action=create — get-or-create a conversation between two users ─────────
async function handleCreateConversation(req: VercelRequest, res: VercelResponse) {
  if (!SERVICE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not set in Vercel env vars' })
  }

  const { participantA, participantB } = req.body || {}
  if (!participantA || !participantB) {
    return res.status(400).json({ error: 'Missing participantA or participantB' })
  }
  if (!UUID.test(String(participantA)) || !UUID.test(String(participantB))) {
    return res.status(400).json({ error: 'Bad participant id' })
  }
  if (!(await callerIs(req, participantA))) return res.status(403).json(NOT_LINKED)

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
    return res.status(500).json({ error: 'Failed to create conversation' })
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
    forwarded, replyToId,
  } = req.body || {}

  if (!conversationId || !senderId || !content) {
    return res.status(400).json({ error: 'Missing: conversationId, senderId, content' })
  }
  // Independent checks — run together instead of back to back (each is a
  // round trip to the database).
  const [isCaller, member] = await Promise.all([callerIs(req, senderId), isParticipant(conversationId, senderId)])
  if (!isCaller) return res.status(403).json(NOT_LINKED)
  if (!member.ok) return res.status(403).json({ error: 'Not in this conversation' })
  if (!['text', 'payment_sent'].includes(type)) return res.status(400).json({ error: 'Bad message type' })
  if (typeof content !== 'string' || content.length > 20000) return res.status(400).json({ error: 'Bad content' })
  if (!PAY_TOKENS[tokenSymbol]) return res.status(400).json({ error: 'Bad token' })

  // Payment cards need a real on-chain payment between the two participants.
  // Wallets always come from the database — never from the request body.
  let payFromWallet: string | null = null, payToWallet: string | null = null
  if (type === 'payment_sent') {
    const amountNum = Number(paymentAmount)
    if (typeof paymentTxHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(paymentTxHash) || !(amountNum > 0) || amountNum > 1e12) {
      return res.status(400).json({ error: 'Bad payment details' })
    }
    const otherId = member.conv.participant_a === senderId ? member.conv.participant_b : member.conv.participant_a
    const ws = await supaFetch(`/users?id=in.(${senderId},${otherId})&select=id,wallet_address`, 'GET')
    for (const u of (ws.ok && Array.isArray(ws.data) ? ws.data : [])) {
      if (u.id === senderId) payFromWallet = u.wallet_address
      if (u.id === otherId) payToWallet = u.wallet_address
    }
    if (!payFromWallet || !payToWallet) return res.status(400).json({ error: 'Wallet not found' })
    const proof = await verifyPayment(paymentTxHash, payFromWallet, payToWallet, tokenSymbol, amountNum)
    if (proof !== 'ok') {
      console.warn('[chat/send] payment card rejected:', proof, paymentTxHash.slice(0, 12))
      return res.status(proof === 'pending' ? 409 : 400).json({ error: proof === 'pending' ? 'Payment not confirmed yet' : 'Payment not found on-chain' })
    }
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
    // WhatsApp-style extras: "Forwarded" label and swipe-to-reply quote.
    ...(forwarded ? { forwarded: true } : {}),
    ...(typeof replyToId === 'string' && /^[0-9a-f-]{36}$/i.test(replyToId) ? { reply_to_id: replyToId } : {}),
  }

  const insertRes = await insertMessage(senderRow)
  if (!insertRes.ok) {
    console.error('[chat/send] sender insert failed:', insertRes.status, JSON.stringify(insertRes.data).slice(0, 300))
    return res.status(500).json({ error: 'DB insert failed' })
  }

  const msgRow = Array.isArray(insertRes.data) ? insertRes.data[0] : insertRes.data
  console.log('[chat/send] ✓ sender msg id:', msgRow?.id)

  // ── 2. Update conversation last_message ────────────────────────────────────
  // Started now, awaited before responding: Vercel freezes the function as
  // soon as it responds, so an un-awaited update was often cut off and the
  // chat list kept showing the previous message.
  const lastMessageUpdate = supaFetch(
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
      // From the database only (verified above) — body-supplied wallets are ignored.
      let senderWallet: string | null = payFromWallet
      let recipientWallet: string | null = payToWallet
      let senderUsername: string | null = null
      // Always look the sender up: the username is needed for the push text
      // and the receive row even when both wallets were passed in (which is
      // every caller) — otherwise every push read "from someone".
      {
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
      const senderName = senderUsername ? senderUsername.replace(/\.arc$/i, '') + '.arc' : null

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
          metadata:              { fromUsername: senderName, source: 'chat-api' },
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
        const fromLabel = senderName ?? 'someone'
        // AWAITED (bounded): a Vercel function is frozen the moment it
        // responds, so an un-awaited push was usually cut off before it
        // reached the push service — the phone got nothing while the app
        // was closed. The sender's UI doesn't wait on this response.
        try {
          const push = await Promise.race([
            sendPushToUser(recipientId, {
              title: 'Received',
              body: `+${paymentAmount} ${tokenSymbol} from ${fromLabel}`,
              url: `/chat/${conversationId}`,
              tag: `payment-${(paymentTxHash || recvRow?.id || '').toString().toLowerCase()}`,
            }),
            new Promise<{ sent: number; failed: number }>(r => setTimeout(() => r({ sent: -1, failed: -1 }), 8000)),
          ])
          console.log('[chat/send] push', push.sent < 0 ? 'timed out' : `sent=${push.sent} failed=${push.failed}`)
        } catch (e: any) {
          console.warn('[chat/send] push error:', e?.message)
        }
      } else {
        console.warn('[chat/send] recipient insert failed:', recvRes.status, JSON.stringify(recvRes.data).slice(0, 200))
      }
    }
  }

  await lastMessageUpdate
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
  if (!(await callerIs(req, senderId))) return res.status(403).json(NOT_LINKED)
  if (!(await isParticipant(conversationId, senderId)).ok) return res.status(403).json({ error: 'Not in this conversation' })

  const patch: Record<string, string> = {
    last_message: lastMessage,
    last_message_at: new Date().toISOString(),
  }
  if (typeof lastMessage !== 'string' || lastMessage.length > 20000) return res.status(400).json({ error: 'Bad message' })
  if (senderId)    patch.last_message_sender = senderId
  if (typeof messageType === 'string' && /^[a-z_]{1,32}$/.test(messageType)) patch.last_message_type = messageType

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
    return res.status(500).json({ error: 'Update failed' })
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // H-3 FIX: restrict CORS to the configured production origin rather than '*'.
  // chat handles authenticated, financial operations — wildcard CORS is too broad.
  const allowedOrigin = process.env.ALLOWED_ORIGIN || ''
  const origin = String(req.headers.origin || '')
  const isLocalDev = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  res.setHeader('Access-Control-Allow-Origin', (allowedOrigin && !isLocalDev) ? allowedOrigin : (origin || '*'))
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Content-Type', 'application/json')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' })

  const action = (req.query.action as string) || ''

  if (action === 'create') return handleCreateConversation(req, res)
  if (action === 'send')   return handleSendMessage(req, res)
  if (action === 'touch')  return handleTouchConversation(req, res)

  return res.status(400).json({ error: 'Missing or unknown action. Use ?action=create|send|touch' })
}
