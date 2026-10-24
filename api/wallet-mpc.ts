// api/wallet-mpc.ts - MeshPort's side (party 2) of the MPC wallet (TESTNET).
//
// One POST endpoint, JSON body { action, ... }, caller = the signed-in
// Supabase user. The protocol work is server/mpc/service.ts; what MeshPort
// agrees to co-sign is server/mpc/requests.ts; this file is HTTP, auth and
// storage only. See docs/MPC_WALLET.md.
//
//   keygen-begin   {}                     → { sid, out, token }
//   keygen-step    { token, msgs }        → { out, token } | { address }
//   sign-begin     { with, request }      → { signId, hash, address, out, token }
//   sign-step      { token, msgs }        → { out, token }
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

async function callerUid(req: VercelRequest): Promise<string | null> {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token || !SERVICE_KEY || !SUPABASE_URL) return null
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } })
  if (!r.ok) return null
  const u = await r.json().catch(() => null) as { id?: string } | null
  return u?.id ?? null
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

const STATUS: Record<MpcServiceError['code'], number> = { 'bad-request': 400, 'no-wallet': 404, exists: 409, expired: 410, protocol: 422 }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const uid = await callerUid(req)
  if (!uid) return res.status(401).json({ error: 'Sign in first' })
  if (!allow(uid)) return res.status(429).json({ error: 'Too many requests - try again in a minute' })
  const body = (req.body ?? {}) as Record<string, any>
  try {
    const svc = await getService()
    switch (body.action) {
      case 'keygen-begin': return res.status(200).json(await svc.keygenBegin(uid))
      case 'keygen-step': return res.status(200).json(await svc.keygenStep(uid, String(body.token ?? ''), body.msgs))
      case 'sign-begin': {
        const withParty = Number(body.with)
        if (withParty !== PHONE && withParty !== BACKUP) return res.status(400).json({ error: 'with must be 1 (phone) or 3 (backup)' })
        return res.status(200).json(await svc.signBegin(uid, { ...hashSignRequest(body.request), with: withParty }))
      }
      case 'sign-step': return res.status(200).json(await svc.signStep(uid, String(body.token ?? ''), body.msgs))
      default: return res.status(400).json({ error: 'Unknown action' })
    }
  } catch (e) {
    if (e instanceof MpcServiceError) return res.status(STATUS[e.code]).json({ error: e.message, code: e.code })
    console.error('[wallet-mpc]', e instanceof Error ? e.message : e)
    return res.status(500).json({ error: 'MPC wallet error' })
  }
}
