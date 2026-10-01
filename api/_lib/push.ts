import webpush from 'web-push'

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

const VAPID_PUBLIC_KEY  = (process.env.VAPID_PUBLIC_KEY  || '').trim()
const VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || '').trim()
const VAPID_SUBJECT     = (process.env.VAPID_SUBJECT || 'mailto:support@meshport.app').trim()

let vapidConfigured = false
function ensureVapid() {
  if (vapidConfigured) return
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    throw new Error('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set')
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
  vapidConfigured = true
}

async function supaFetch(path: string, method: string, body?: object) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      'apikey':        SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        method === 'POST' ? 'return=representation' : 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { json = text }
  return { ok: res.ok, status: res.status, data: json }
}

export interface PushPayload {
  title: string
  body: string
  icon?: string
  url?: string
  tag?: string
  data?: Record<string, any>
}

/**
 * Sends a push notification to EVERY subscribed device across all users.
 * Used by the admin broadcast panel. Prunes dead subscriptions the same way
 * sendPushToUser does.
 */
export async function sendPushToAll(payload: PushPayload): Promise<{ sent: number; failed: number }> {
  try {
    ensureVapid()
  } catch (e: any) {
    console.warn('[push] VAPID not configured, skipping broadcast:', e?.message)
    return { sent: 0, failed: 0 }
  }

  const subsRes = await supaFetch(`/push_subscriptions?select=id,endpoint,p256dh,auth`, 'GET')
  if (!subsRes.ok || !Array.isArray(subsRes.data) || subsRes.data.length === 0) {
    return { sent: 0, failed: 0 }
  }

  const notificationPayload = JSON.stringify({
    title: payload.title,
    body:  payload.body,
    icon:  payload.icon || '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    tag:   payload.tag,
    data:  { url: payload.url || '/', ...payload.data },
  })

  let sent = 0, failed = 0
  const deadIds: string[] = []

  await Promise.all(subsRes.data.map(async (sub: any) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        notificationPayload,
      )
      sent++
    } catch (err: any) {
      failed++
      if (err?.statusCode === 404 || err?.statusCode === 410) deadIds.push(sub.id)
      else console.warn('[push] broadcast send failed:', err?.statusCode, err?.message)
    }
  }))

  if (deadIds.length > 0) {
    supaFetch(`/push_subscriptions?id=in.(${deadIds.join(',')})`, 'DELETE').catch(() => {})
  }

  return { sent, failed }
}

/**
 * Resolves a Supabase access token to a user id, and confirms that user is
 * a whitelisted admin. Used to authorize admin-only endpoints like the
 * broadcast panel without duplicating this check in every route.
 */
export async function resolveAdminFromToken(accessToken: string | undefined): Promise<{ id: string; email: string | null } | null> {
  if (!accessToken) return null
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey':        SERVICE_KEY,
        'Authorization': `Bearer ${accessToken}`,
      },
    })
    if (!userRes.ok) return null
    const user = await userRes.json()
    if (!user?.id) return null

    const adminRes = await supaFetch(`/admin_users?id=eq.${user.id}&select=id`, 'GET')
    if (!adminRes.ok || !Array.isArray(adminRes.data) || adminRes.data.length === 0) return null

    return { id: user.id, email: user.email || null }
  } catch (e: any) {
    console.warn('[push] resolveAdminFromToken failed:', e?.message)
    return null
  }
}

/**
 * Resolves a Supabase access token to THIS APP's own user id (users.id) —
 * not just the raw Supabase auth uid. Every account, including wallet-only
 * ones that never do email/OTP login, gets a real Supabase session via
 * anonymous sign-in (see ensureAnonSession in src/lib/supabase.ts), and
 * syncAuthUidToProfile links that session's auth uid to users.id via the
 * users.auth_uid column. That's the same bridge this uses, so the mapping
 * is consistent with however the rest of the app already identifies a
 * signed-in account.
 *
 * Used to authorize action=send: the caller must prove (via their own
 * session token) that they ARE the userId they're asking to be pushed to,
 * so one account can't push arbitrary notification content to another.
 * Fails closed — if auth_uid isn't populated yet for an account (e.g. the
 * backfill in syncAuthUidToProfile hasn't run for it), this returns null
 * and the push is denied rather than allowed by default.
 */
export async function resolveUserFromToken(accessToken: string | undefined): Promise<{ appUserId: string; authUid: string } | null> {
  if (!accessToken) return null
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey':        SERVICE_KEY,
        'Authorization': `Bearer ${accessToken}`,
      },
    })
    if (!userRes.ok) return null
    const authUser = await userRes.json()
    if (!authUser?.id) return null

    const rowRes = await supaFetch(`/users?auth_uid=eq.${authUser.id}&select=id`, 'GET')
    const appUserId = rowRes.ok && Array.isArray(rowRes.data) ? rowRes.data[0]?.id : null
    if (!appUserId) return null

    return { appUserId, authUid: authUser.id }
  } catch (e: any) {
    console.warn('[push] resolveUserFromToken failed:', e?.message)
    return null
  }
}

/**
 * Sends a push notification to every device a user has subscribed on.
 * Silently no-ops (returns { sent: 0 }) if VAPID isn't configured or the
 * user has no subscriptions — callers should never let this block the
 * underlying payment/swap/reward flow.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<{ sent: number; failed: number }> {
  if (!userId) return { sent: 0, failed: 0 }
  try {
    ensureVapid()
  } catch (e: any) {
    console.warn('[push] VAPID not configured, skipping push:', e?.message)
    return { sent: 0, failed: 0 }
  }

  const subsRes = await supaFetch(`/push_subscriptions?user_id=eq.${userId}&select=id,endpoint,p256dh,auth`, 'GET')
  if (!subsRes.ok || !Array.isArray(subsRes.data) || subsRes.data.length === 0) {
    return { sent: 0, failed: 0 }
  }

  const notificationPayload = JSON.stringify({
    title: payload.title,
    body:  payload.body,
    icon:  payload.icon || '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    tag:   payload.tag,
    data:  { url: payload.url || '/', ...payload.data },
  })

  let sent = 0, failed = 0
  const deadIds: string[] = []

  await Promise.all(subsRes.data.map(async (sub: any) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        notificationPayload,
      )
      sent++
    } catch (err: any) {
      failed++
      // 404/410 = subscription expired or unsubscribed — clean it up
      if (err?.statusCode === 404 || err?.statusCode === 410) deadIds.push(sub.id)
      else console.warn('[push] send failed:', err?.statusCode, err?.message)
    }
  }))

  if (deadIds.length > 0) {
    supaFetch(`/push_subscriptions?id=in.(${deadIds.join(',')})`, 'DELETE').catch(() => {})
  }

  return { sent, failed }
}
