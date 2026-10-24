// api/wallet-mpc.ts - MeshPort's side (party 2) of the MPC wallet (TESTNET).
//
// One POST endpoint, JSON body { action, ... }, caller = the signed-in
// Supabase user. The protocol work is server/mpc/service.ts; what MeshPort
// agrees to co-sign is server/mpc/requests.ts; this file is HTTP, auth and
// storage only. See docs/MPC_WALLET.md.
//
//   wallet         {}                            → { address | null }
//   keygen-begin   { phonePub }                  → { sid, hello, box, token }
//   keygen-step    { token, box }                → { box, token } | { address }
//   sign-begin     { with, request, phonePub }   → { signId, hash, address, hello, box, token }
//   sign-step      { token, box }                → { box, token }
//
// Protocol messages travel only inside end-to-end boxes between the wallet
// frame and this service (src/wallet/mpc/channel.ts); `hello` is this
// service's session key signed by its identity key, which the frame pins.
// Each (session, step) is accepted once (wallet_mpc_steps).
//
// Runs on Vercel rather than as a Supabase Edge Function: one key-generation
// round needs ~1.8 s of CPU, close to Edge Functions' 2 s cap.
//
// Env: MPC_SECRET (64+ hex chars, derives the sealing keys), SUPABASE_URL,
// SUPABASE_SERVICE_KEY / SUPABASE_SERVICE_ROLE_KEY.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { readFileSync } from 'fs'
import path from 'path'
import { loadMpc } from '../src/wallet/mpc/wasm'
import { BACKUP, PHONE } from '../src/wallet/mpc/protocol'
import { createMpcService, MpcServiceError, type MpcRepo, type MpcService } from '../server/mpc/service'
import { hashSignRequest } from '../server/mpc/requests'

const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim()
const SERVICE_KEY  = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
const svcHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }

async function rest(pathAndQuery: string, init?: RequestInit): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { ...init, headers: { ...svcHeaders, ...(init?.headers ?? {}) } })
}

const repo: MpcRepo = {
  async activeShare(authUid) {
    const r = await rest(`wallet_mpc_shares?auth_uid=eq.${encodeURIComponent(authUid)}&revoked_at=is.null&select=address,share_ct`)
    if (!r.ok) throw new Error(`share lookup failed (${r.status})`)
    const rows = await r.json() as Array<{ address: string; share_ct: string }>
    return rows[0] ? { address: rows[0].address, shareCt: rows[0].share_ct } : null
  },
  async saveShare(authUid, address, shareCt) {
    const r = await rest('wallet_mpc_shares', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ auth_uid: authUid, address, share_ct: shareCt }),
    })
    if (r.status === 409) return 'exists' // unique index: one live wallet per account
    if (!r.ok) throw new Error(`share save failed (${r.status})`)
    return 'saved'
  },
  async consumeStep(sessionId, step) {
    const r = await rest('wallet_mpc_steps', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ session_id: sessionId, step }),
    })
    if (r.status === 409) return false // primary key (session_id, step): already used
    if (!r.ok) throw new Error(`step record failed (${r.status})`)
    return true
  },
  async logSign(e) {
    const r = await rest('wallet_mpc_sign_log', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ auth_uid: e.authUid, address: e.address, sign_id: e.signId, hash: e.hash, kind: e.kind, summary: e.summary }),
    })
    if (!r.ok) throw new Error(`sign log failed (${r.status})`) // no log, no signature
  },
}

let service: Promise<MpcService> | null = null
function getService(): Promise<MpcService> {
  if (service) return service
  const hex = (process.env.MPC_SECRET || '').trim()
  if (!/^[0-9a-fA-F]{64,}$/.test(hex) || hex.length % 2) {
    return Promise.reject(new MpcServiceError('bad-request', 'MPC wallet is not configured'))
  }
  const secret = Uint8Array.from(Buffer.from(hex, 'hex'))
  // vercel.json includeFiles ships the module with this function.
  const bytes = readFileSync(path.join(process.cwd(), 'src/wallet/mpc/meshport_mpc.wasm'))
  service = loadMpc(bytes).then(mpc => createMpcService({ mpc, repo, secret }))
  service.catch(() => { service = null })
  return service
}

async function caller(req: VercelRequest): Promise<{ uid: string; anonymous: boolean } | null> {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token || !SERVICE_KEY || !SUPABASE_URL) return null
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } })
  if (!r.ok) return null
  const u = await r.json().catch(() => null) as { id?: string; is_anonymous?: boolean } | null
  return u?.id ? { uid: u.id, anonymous: u.is_anonymous === true } : null
}

// Per warm instance: 60 requests a minute per account (a signup is 4, a
// payment 2), so a stolen session can't hammer the signer.
const recent = new Map<string, number[]>()
function allow(uid: string): boolean {
  const now = Date.now()
  const hits = (recent.get(uid) ?? []).filter(t => now - t < 60_000)
  if (hits.length >= 60) return false
  hits.push(now)
  recent.set(uid, hits)
  if (recent.size > 5000) recent.delete(recent.keys().next().value!)
  return true
}

const STATUS: Record<MpcServiceError['code'], number> = { 'bad-request': 400, 'no-wallet': 404, exists: 409, replayed: 409, expired: 410, protocol: 422 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  // Where the time goes, for every request: Server-Timing (the app shows it)
  // and one log line. No ids, tokens or boxes are logged.
  const t0 = performance.now()
  const body = (req.body ?? {}) as Record<string, any>
  const action = typeof body.action === 'string' ? body.action.slice(0, 20) : '?'
  const ms = { auth: 0, init: 0, mpc: 0 }
  const cold = service === null
  const send = (status: number, payload: unknown) => {
    const total = performance.now() - t0
    const d = (n: number) => n.toFixed(0)
    res.setHeader('Server-Timing', `auth;dur=${d(ms.auth)}, init;dur=${d(ms.init)}, mpc;dur=${d(ms.mpc)}, total;dur=${d(total)}`)
    console.log(`[wallet-mpc] ${action} ${status} total=${d(total)}ms auth=${d(ms.auth)} init=${d(ms.init)} mpc=${d(ms.mpc)}${cold ? ' cold' : ''}`)
    return res.status(status).json(payload)
  }

  let t = performance.now()
  const who = await caller(req)
  ms.auth = performance.now() - t
  if (!who) return send(401, { error: 'Sign in first' })
  const { uid } = who
  if (!allow(uid)) return send(429, { error: 'Too many requests - try again in a minute' })
  try {
    t = performance.now()
    const svc = await getService()
    ms.init = performance.now() - t
    t = performance.now()
    const done = (payload: unknown) => { ms.mpc = performance.now() - t; return send(200, payload) }
    switch (body.action) {
      // For setting VITE_WALLET_MPC_SERVER_KEY at build time; the frame never trusts this at run time.
      case 'identity': return done({ identityPub: svc.identityPub })
      // This account's MPC wallet address, if it has one.
      case 'wallet': return done({ address: (await repo.activeShare(uid))?.address ?? null })
      case 'keygen-begin':
        // The share is filed under the account's id; an anonymous session's id
        // is gone when the session resets, and the wallet with it.
        if (who.anonymous) return send(403, { error: 'Sign in with Google or email to create this wallet' })
        return done(await svc.keygenBegin(uid, String(body.phonePub ?? '') as `0x${string}`))
      case 'keygen-step': return done(await svc.keygenStep(uid, String(body.token ?? ''), String(body.box ?? '')))
      case 'sign-begin': {
        const withParty = Number(body.with)
        if (withParty !== PHONE && withParty !== BACKUP) return send(400, { error: 'with must be 1 (phone) or 3 (backup)' })
        return done(await svc.signBegin(uid, { ...hashSignRequest(body.request), with: withParty }, String(body.phonePub ?? '') as `0x${string}`))
      }
      case 'sign-step': return done(await svc.signStep(uid, String(body.token ?? ''), String(body.box ?? '')))
      default: return send(400, { error: 'Unknown action' })
    }
  } catch (e) {
    if (e instanceof MpcServiceError) return send(STATUS[e.code], { error: e.message, code: e.code })
    console.error('[wallet-mpc]', e instanceof Error ? e.message : e)
    return send(500, { error: 'MPC wallet error' })
  }
}
