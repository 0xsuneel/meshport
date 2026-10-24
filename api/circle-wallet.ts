// api/circle-wallet.ts - MeshPort's backend for Circle user-controlled wallets.
//
// One POST endpoint, JSON body { action, ... }. social-device-token starts a
// Google sign-in, so it needs no MeshPort session (limited per IP); every
// other action needs one (Supabase, not anonymous). Actions that act for a
// Circle user also take that user's Circle session (`userToken`), which stays
// in the browser; server/circle/service.ts checks it belongs to this account.
//
//   social-device-token  { deviceId }                          → { deviceToken, deviceEncryptionKey }
//   email-device-token   { deviceId }                          → { deviceToken, deviceEncryptionKey, otpToken }
//                         (always this MeshPort account's email)
//   refresh              { userToken, refreshToken, deviceId } → { userToken, encryptionKey, refreshToken }
//   link                 { userToken }                         → { circleUserId }
//   initialize           { userToken }                         → { challengeId } | { ready: true }
//   wallet               { userToken }                         → { walletId, address, blockchain }
//   sign-transaction     { userToken, transaction }            → { challengeId }  (the app broadcasts)
//   sign-message         { userToken, message, encodedByHex? } → { challengeId }
//   sign-typed           { userToken, typedData }              → { challengeId }
//   challenge            { userToken, challengeId }            → { status, type, … }
//
// Env: CIRCLE_API_KEY (Circle Console standard key, PREFIX:ID:SECRET),
// SUPABASE_URL, SUPABASE_SERVICE_KEY / SUPABASE_SERVICE_ROLE_KEY.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createCircleClient } from '../server/circle/client'
import { createCircleWalletService, CircleWalletError, type CircleRepo, type CircleWalletService } from '../server/circle/service'

const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim()
const SERVICE_KEY  = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
const svcHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }

async function rest(pathAndQuery: string, init?: RequestInit): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { ...init, headers: { ...svcHeaders, ...(init?.headers ?? {}) } })
}

const repo: CircleRepo = {
  async link(authUid) {
    const r = await rest(`circle_wallet_users?auth_uid=eq.${encodeURIComponent(authUid)}&select=circle_user_id,wallet_id,address,blockchain`)
    if (!r.ok) throw new Error(`link lookup failed (${r.status})`)
    const rows = await r.json() as Array<{ circle_user_id: string; wallet_id: string | null; address: string | null; blockchain: string | null }>
    return rows[0] ? { circleUserId: rows[0].circle_user_id, walletId: rows[0].wallet_id, address: rows[0].address, blockchain: rows[0].blockchain } : null
  },
  async saveLink(authUid, circleUserId) {
    const r = await rest('circle_wallet_users', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ auth_uid: authUid, circle_user_id: circleUserId }),
    })
    if (r.status === 409) return 'taken' // that Circle user is linked to another account
    if (!r.ok) throw new Error(`link save failed (${r.status})`)
    return 'saved'
  },
  async saveWallet(authUid, walletId, address, blockchain) {
    const r = await rest(`circle_wallet_users?auth_uid=eq.${encodeURIComponent(authUid)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ wallet_id: walletId, address, blockchain, updated_at: new Date().toISOString() }),
    })
    if (!r.ok) throw new Error(`wallet save failed (${r.status})`)
  },
}

let service: CircleWalletService | null = null
function getService(): CircleWalletService {
  if (service) return service
  const apiKey = (process.env.CIRCLE_API_KEY || '').trim()
  if (!apiKey) throw new CircleWalletError('circle', 'Circle wallets are not configured')
  service = createCircleWalletService({ circle: createCircleClient({ apiKey }), repo })
  return service
}

async function caller(req: VercelRequest): Promise<{ uid: string; email: string | null; anonymous: boolean } | null> {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token || !SERVICE_KEY || !SUPABASE_URL) return null
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } })
  if (!r.ok) return null
  const u = await r.json().catch(() => null) as { id?: string; email?: string; is_anonymous?: boolean } | null
  return u?.id ? { uid: u.id, email: u.email ?? null, anonymous: u.is_anonymous === true } : null
}

// Per warm instance: 120 requests a minute per account; 10 sign-in starts a
// minute per IP (before anyone is signed in).
const recent = new Map<string, number[]>()
function allow(key: string, max = 120): boolean {
  const now = Date.now()
  const hits = (recent.get(key) ?? []).filter(t => now - t < 60_000)
  if (hits.length >= max) return false
  hits.push(now)
  recent.set(key, hits)
  if (recent.size > 5000) recent.delete(recent.keys().next().value!)
  return true
}
const clientIp = (req: VercelRequest) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown'

const STATUS: Record<CircleWalletError['code'], number> = {
  'bad-request': 400, session: 401, 'not-linked': 404, 'linked-elsewhere': 409, 'no-wallet': 404, circle: 502,
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const started = Date.now()
  const body = (req.body ?? {}) as Record<string, any>
  const action = typeof body.action === 'string' ? body.action.slice(0, 24) : '?'
  const send = (status: number, payload: unknown) => {
    console.log(`[circle-wallet] ${action} ${status} ${Date.now() - started}ms`) // no ids or tokens
    return res.status(status).json(payload)
  }

  if (body.action === 'social-device-token') {
    if (!allow('ip:' + clientIp(req), 10)) return send(429, { error: 'Too many sign-in attempts - try again in a minute' })
    try { return send(200, await getService().socialDeviceToken(body.deviceId)) } catch (e) {
      if (e instanceof CircleWalletError) return send(STATUS[e.code], { error: e.message, code: e.code })
      console.error('[circle-wallet]', e instanceof Error ? e.message : e)
      return send(500, { error: 'Wallet service error' })
    }
  }

  const who = await caller(req)
  if (!who) return send(401, { error: 'Sign in to MeshPort first', code: 'meshport-session' })
  // A wallet hangs off the account's id; an anonymous session's id doesn't last.
  if (who.anonymous) return send(403, { error: 'Sign in with Google or email to use your wallet' })
  if (!allow(who.uid)) return send(429, { error: 'Too many requests - try again in a minute' })

  try {
    const svc = getService()
    const uid = who.uid
    const t = body.userToken
    switch (body.action) {
      case 'email-device-token': return send(200, await svc.emailDeviceToken(body.deviceId, who.email))
      case 'refresh': return send(200, await svc.refresh(t, body.refreshToken, body.deviceId))
      case 'link': return send(200, await svc.link(uid, t))
      case 'initialize': return send(200, await svc.initialize(uid, t))
      case 'wallet': return send(200, await svc.wallet(uid, t))
      case 'sign-transaction': return send(200, await svc.signTransaction(uid, t, body))
      case 'sign-message': return send(200, await svc.signMessage(uid, t, body))
      case 'sign-typed': return send(200, await svc.signTypedData(uid, t, body))
      case 'challenge': return send(200, await svc.challenge(uid, t, body.challengeId))
      default: return send(400, { error: 'Unknown action' })
    }
  } catch (e) {
    if (e instanceof CircleWalletError) return send(STATUS[e.code], { error: e.message, code: e.code })
    console.error('[circle-wallet]', e instanceof Error ? e.message : e)
    return send(500, { error: 'Wallet service error' })
  }
}
