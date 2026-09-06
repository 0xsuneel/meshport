import type { VercelRequest, VercelResponse } from '@vercel/node'
import { sendPushToUser, sendPushToAll, resolveAdminFromToken, resolveUserFromToken } from './_lib/push'

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

// ── action=subscribe — save a device's Web Push subscription ────────────────
async function handleSubscribe(req: VercelRequest, res: VercelResponse) {
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Server misconfigured' })

  const { userId, subscription } = req.body || {}
  if (!userId || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'Missing userId or subscription' })
  }

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?on_conflict=endpoint`, {
      method: 'POST',
      headers: {
        'apikey':        SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        user_id:    userId,
        endpoint:   subscription.endpoint,
        p256dh:     subscription.keys.p256dh,
        auth:       subscription.keys.auth,
        user_agent: req.headers['user-agent'] || null,
      }),
    })
    if (!r.ok) {
      const detail = await r.text().catch(() => '')
      console.error('[push/subscribe] insert failed:', r.status, detail.slice(0, 300))
      return res.status(500).json({ error: 'DB insert failed' })
    }
    return res.status(200).json({ ok: true })
  } catch (e: any) {
    console.error('[push/subscribe] error:', e?.message)
    return res.status(500).json({ error: e?.message || 'Unknown error' })
  }
}

// ── action=send — notify a single user (payment received, swap, claim) ─────
// Requires the caller's own session token to resolve to this exact userId
// (see resolveUserFromToken) — otherwise this was a fully open endpoint:
// any client could POST an arbitrary userId + title/body and push a real
// OS notification to that account's device, with nothing to stop pushing
// to someone else's account.
async function handleSend(req: VercelRequest, res: VercelResponse) {
  const { userId, title, body, url, tag, data } = req.body || {}
  if (!userId || !title || !body) {
    return res.status(400).json({ error: 'Missing userId, title, or body' })
  }

  const authHeader = req.headers['authorization'] || ''
  const accessToken = Array.isArray(authHeader)
    ? authHeader[0]?.replace(/^Bearer\s+/i, '')
    : authHeader.replace(/^Bearer\s+/i, '')

  const caller = await resolveUserFromToken(accessToken)
  if (!caller || caller.appUserId !== userId) {
    return res.status(403).json({ error: 'Not authorized to notify this user' })
  }

  try {
    const result = await sendPushToUser(userId, { title, body, url, tag, data })
    return res.status(200).json(result)
  } catch (e: any) {
    console.error('[push/send] error:', e?.message)
    return res.status(500).json({ error: e?.message || 'Unknown error' })
  }
}

// ── action=send-internal — server-to-server, shared-secret authorized ───────
// action=send requires a per-user session token, which is correct for
// browser clients pushing to their own account — but trusted backend
// infrastructure (a Supabase edge function running on a schedule, with no
// user ever "logged in" to attach a token from) has no session to offer.
// This is for exactly that case: e.g. a background scan that detects
// newly-claimable funds on an external chain and wants to notify the
// affected user, with no browser tab involved at all. Authorized by a
// shared secret instead — set PUSH_INTERNAL_SECRET in Vercel env vars and
// have the calling server pass the same value, never exposed to any client.
async function handleSendInternal(req: VercelRequest, res: VercelResponse) {
  const secret = (process.env.PUSH_INTERNAL_SECRET || '').trim()
  if (!secret) return res.status(500).json({ error: 'PUSH_INTERNAL_SECRET not configured' })

  const authHeader = req.headers['authorization'] || ''
  const provided = (Array.isArray(authHeader) ? authHeader[0] : authHeader).replace(/^Bearer\s+/i, '')
  if (provided !== secret) return res.status(403).json({ error: 'Invalid internal secret' })

  const { userId, title, body, url, tag, data } = req.body || {}
  if (!userId || !title || !body) {
    return res.status(400).json({ error: 'Missing userId, title, or body' })
  }

  try {
    const result = await sendPushToUser(userId, { title, body, url, tag, data })
    return res.status(200).json(result)
  } catch (e: any) {
    console.error('[push/send-internal] error:', e?.message)
    return res.status(500).json({ error: e?.message || 'Unknown error' })
  }
}

// ── action=broadcast — admin-only, notify every user ────────────────────────
async function handleBroadcast(req: VercelRequest, res: VercelResponse) {
  const authHeader = req.headers['authorization'] || ''
  const accessToken = Array.isArray(authHeader)
    ? authHeader[0]?.replace(/^Bearer\s+/i, '')
    : authHeader.replace(/^Bearer\s+/i, '')

  const admin = await resolveAdminFromToken(accessToken)
  if (!admin) return res.status(403).json({ error: 'Admin access required' })

  if (req.method === 'GET') {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/admin_broadcasts?select=*&order=created_at.desc&limit=20`, {
        headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
      })
      const data = await r.json().catch(() => [])
      return res.status(200).json({ data })
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || 'Unknown error' })
    }
  }

  const { title, body, url } = req.body || {}
  if (!title || !body) return res.status(400).json({ error: 'Missing title or body' })

  try {
    const result = await sendPushToAll({ title, body, url: url || '/notifications', tag: 'admin-broadcast' })

    await fetch(`${SUPABASE_URL}/rest/v1/admin_broadcasts`, {
      method: 'POST',
      headers: {
        'apikey':        SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({
        title, body,
        sent_count:   result.sent,
        failed_count: result.failed,
        created_by:   admin.email || admin.id,
      }),
    }).catch(() => {})

    return res.status(200).json(result)
  } catch (e: any) {
    console.error('[push/broadcast] error:', e?.message)
    return res.status(500).json({ error: e?.message || 'Unknown error' })
  }
}

// ── action=feed — public, read-only broadcast history for the in-app ───────
// Notifications page. No admin auth required (this is intentionally public:
// it only exposes title/body/created_at, the same content already pushed to
// everyone). Lets the app show admin broadcasts inline even for users who
// never granted OS push permission or are on a platform that doesn't
// support Web Push (e.g. iOS Safari without "Add to Home Screen").
async function handleFeed(req: VercelRequest, res: VercelResponse) {
  try {
    const since = (req.query.since as string) || ''
    const sinceFilter = since ? `&created_at=gt.${encodeURIComponent(since)}` : ''
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/admin_broadcasts?select=id,title,body,created_at&order=created_at.desc&limit=20${sinceFilter}`,
      { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
    )
    const data = await r.json().catch(() => [])
    return res.status(200).json({ data: Array.isArray(data) ? data : [] })
  } catch (e: any) {
    console.error('[push/feed] error:', e?.message)
    return res.status(500).json({ data: [] })
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Content-Type', 'application/json')

  if (req.method === 'OPTIONS') return res.status(200).end()

  const action = (req.query.action as string) || (req.body && req.body.action) || ''

  if (action === 'subscribe') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    return handleSubscribe(req, res)
  }
  if (action === 'send') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    return handleSend(req, res)
  }
  if (action === 'send-internal') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    return handleSendInternal(req, res)
  }
  if (action === 'broadcast') {
    return handleBroadcast(req, res)
  }
  if (action === 'feed') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
    return handleFeed(req, res)
  }

  return res.status(400).json({ error: 'Missing or unknown action. Use ?action=subscribe|send|send-internal|broadcast|feed' })
}
